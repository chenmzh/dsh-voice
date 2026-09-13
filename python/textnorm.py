#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Text normalization for the local TTS engines installed under ``.runtime/tts``.

WHY THIS MODULE EXISTS (measured, not guessed) -- please do not "simplify" it away
===============================================================================

Two failure modes were reproduced on this machine by synthesizing
``.runtime/tts/tools/reference.txt`` with each engine and transcribing the audio
back with a local Whisper ASR (see ``asr_score.py`` / ``summarize.py`` and the
scores in ``tts-bakeoff/``):

1. **Raw digits / dates / percentages are garbled by engines that have no
   Chinese text frontend.**  F5-TTS, on the test sentence, produced audio that
   Whisper transcribed back as ``今天是236年9月11日`` (``2026`` -> ``236``),
   ``芯片价格是出了UZ的美元`` (``1280元`` -> garbled) and ``涨幅坠盘5%``
   (``3.5%`` -> garbled); CER 0.1463 on the Chinese half.  IndexTTS-2.5 and
   Kokoro rendered the very same sentence verbatim (CER 0.0000), which proves the
   reference text is fine and that the digits are the problem, not the sentence.
   CosyVoice is expected to behave like F5-TTS here because its venv is missing
   both ``pynini`` and ``ttsfrd``, i.e. both of its normal text frontends, so it
   also receives digits with no frontend to expand them.

   => ``spell_out_numbers()`` exists to pre-expand digits into Chinese words for
   exactly those engines.  It is *not* applied to Kokoro by default, because
   Kokoro already reads digits correctly and expanding them can only regress it.

2. **Markdown and code are spoken as garbage.**  Feeding a realistic agent reply
   (headings, ``**bold**``, a fenced ```python block, a shell command such as
   ``nvidia-smi``, a URL, a filename such as ``bakeoff.sh``) to Kokoro produced
   CER 0.0652, and the model audibly read non-speech tokens -- the ASR heard
   nonsense such as ``参考易得说明详鉴文件``.

   => ``strip_markdown()`` exists to remove markup, code, tables and URLs before
   synthesis.  Anything that reads assistant replies aloud must call it first.

Dependencies: **standard library only** (Python 3.11/3.12).  No pypinyin, no
num2words, no pip package.  Pure CPU; this module never touches a GPU.

Documented reading choices (each one is covered by a test in
``test_textnorm.py``):

* Pipe tables are **dropped entirely** (rows and separator line alike) rather
  than rendered as prose: a spoken row of cell values without headers is worse
  than silence.
* Fenced code blocks are dropped **with their content**, inline ``code`` spans
  keep their inner text (``pip install x`` reads fine as words).
* ``![alt](url)`` keeps the alt text; ``[text](url)`` keeps the link text.
* Bare URLs are replaced by the spoken placeholder ``链接`` in Chinese text and
  dropped in Latin text, so the listener is told something was omitted instead
  of hearing a spelled-out URL.  Caveat: a scheme-less host such as
  ``example.com`` is not recognized as a URL and survives as literal text.
* Markdown-like markers that are only removal candidates when they are real
  markup: ``a * b * c``, ``2026 # 1`` and mid-sentence ``*``/``#`` are left
  intact, because eating a legitimate ``#`` or ``*`` changes the sentence.
* ``$`` shell prompts, ``--flag`` arguments and version numbers are treated as
  code: the symbol is stripped, the alphanumeric payload is kept as plain text
  (``nvidia-smi``, ``flag=value``, ``v1.2.3``) instead of being spoken as
  symbols.  Command *output* should not be fed to TTS at all.
* Number spelling is only applied to Arabic digits, and only to a digit run that
  *starts* a token.  Latin-script text is never touched, and these are deliberately
  left alone:

  - ``16GB``, ``RTX 5070 Ti``'s unit ``Ti``, ``bakeoff.sh``, ``sm_120``, ``v1.2.3``,
    ``3.5.1``: a digit glued to (or a dotted version followed by) a Latin letter is
    an English/technical token, not a Chinese quantity.  NOTE the consequence for
    ``RTX 5070 Ti``: the *bare* number is still expanded, giving
    ``RTX 五千零七十 Ti``, which is the safer reading for an engine with no text
    frontend but is a known, accepted compromise.
  - ``1280MB``, ``16GB``: a Latin unit stays Latin.  Spelling a memory size as
    一千二百八十兆字节 would be worse in practice, so the number is left with it.
  - ``2020-2021``, ``1-5``, ``1/2``, ``16/9``: ranges and fractions are parked in a
    placeholder and restored verbatim.  Reading ``1/2`` as 二分之一 is wrong for
    "16/9 画幅", and a half-expanded range (``2020-二零二一年``) is worse than either.
  - ``example.com``, bare ``http``-less hosts: not recognized as URLs and left as
    literal text.

* Chinese number reading rules implemented here (and unit-tested):
  ``120`` -> 一百二十, ``1000`` -> 一千, ``1005`` -> 一千零五, ``10005`` -> 一万零五,
  and the 一十 -> 十 collapse in the leading position: ``10`` -> 十, ``15`` -> 十五,
  ``100000`` -> 十万, ``1100000000`` -> 十一亿, while a unit inside the same group
  keeps the 一 (``110`` -> 一百一十, ``1015`` -> 一千零一十五).

* What is deliberately NOT handled: English number spelling (``1.4`` -> "one point
  four") -- these engines get Chinese or digit text, never English words; mixed
  CJK-Latin numeric units (see ``1280MB`` above); and spelling inside an already
  written Chinese numeral (``百分之3.5`` is completed, not re-derived).
"""

from __future__ import annotations

import argparse
import re
import sys

__all__ = [
    "strip_markdown",
    "spell_out_numbers",
    "prepare_for_tts",
    "segment_text",
    "link_replaced",
]

# --------------------------------------------------------------------------- #
# Chinese numerals
# --------------------------------------------------------------------------- #

_DIGITS_ZH = "零一二三四五六七八九"
_GROUP_UNITS = ("", "万", "亿")          # 10^0, 10^4, 10^8 grouping
_SUB_UNITS = ("", "十", "百", "千")      # inside a 4-digit group

#: Placeholder used when a bare URL is dropped from Chinese text.
URL_PLACEHOLDER_ZH = "链接"


def _digits_to_zh(digits: str) -> str:
    """Read a run of digits digit-by-digit: ``2026`` -> ``二零二六``.

    Correct for years, phone numbers, ids and decimal fractions in Chinese.
    """
    return "".join(_DIGITS_ZH[int(ch)] for ch in digits if ch.isdigit())


def _four_digit_group_to_zh(group: int, *, is_top_group: bool) -> str:
    """Convert one 1..9999 group.  No zero-collapsing across group boundaries.

    ``is_top_group`` is True for the most significant group of the number, which
    is what decides whether a leading tens digit is written 十 or 一十.
    """
    out: list[str] = []
    zero_pending = False
    for pos in range(3, -1, -1):          # thousands -> units
        unit = 10 ** pos
        digit = (group // unit) % 10
        if digit == 0:
            if out:
                zero_pending = True
            continue
        if zero_pending:
            out.append(_DIGITS_ZH[0])
            zero_pending = False
        # 一十 -> 十 only when this 一 is the very first digit of the number:
        # 15 -> 十五, 10 -> 十, 100000 -> 十万 (top group 0010), but
        # 110 -> 一百一十, 1015 -> 一千零一十五 and 1100000000 -> 一十一亿 keep
        # the 一.  "一百十" is heard as an abbreviation, not a reading, so the
        # explicit form is preferred in the ambiguous case.
        is_first_digit = is_top_group and (group // 10 ** (pos + 1)) == 0
        if digit == 1 and pos == 1 and is_first_digit:
            out.append(_SUB_UNITS[1])
        else:
            out.append(_DIGITS_ZH[digit] + _SUB_UNITS[pos])
    if not out:
        return _DIGITS_ZH[0]
    return "".join(out)


def _group_zero_fill(lower_group: int) -> bool:
    """A gap between two 4-digit groups needs a 零 when the lower group < 1000.

    ``1_0005`` -> ``一万零五`` (lower group 5 < 1000 -> 零), while ``1_2800`` ->
    ``一万二千八百`` (lower group 2800 -> no 零).
    """
    return lower_group < 1000


def _int_to_zh(value: int | str) -> str:
    """Chinese cardinal reading of an integer.

    ``120`` -> ``一百二十``, ``1000`` -> ``一千``, ``1005`` -> ``一千零五``,
    ``10005`` -> ``一万零五``, ``1010`` -> ``一千零一十``, ``11`` -> ``十一``.
    """
    if isinstance(value, str):
        value = int(value) if value else 0
    if value == 0:
        return _DIGITS_ZH[0]
    negative = value < 0
    magnitude = abs(value)

    # Split into 4-digit groups from the least significant side.
    groups: list[int] = []
    remaining = magnitude
    while remaining > 0:
        groups.append(remaining % 10000)
        remaining //= 10000
    if len(groups) > len(_GROUP_UNITS):
        # Beyond 亿 (10^16): fall back to digit-by-digit.  Rare, still spoken
        # correctly one digit at a time rather than silently mangled.
        return ("负" if negative else "") + _digits_to_zh(str(magnitude))

    out: list[str] = []
    for index in range(len(groups) - 1, -1, -1):
        group = groups[index]
        if group == 0:
            continue
        if out and _group_zero_fill(group):
            out.append(_DIGITS_ZH[0])
        out.append(
            _four_digit_group_to_zh(group, is_top_group=(index == len(groups) - 1))
        )
        out.append(_GROUP_UNITS[index])
    text = "".join(out)
    return ("负" + text) if negative else text


def _number_str_to_zh(raw: str) -> str:
    """``1,280`` -> ``一千二百八十``;  ``3.50`` -> ``三点五零``; ``-5`` -> ``负五``."""
    raw = raw.strip()
    negative = raw.startswith("-")
    if negative:
        raw = raw[1:]
    raw = raw.replace(",", "").replace("，", "")
    if "." in raw:
        int_part, _, frac_part = raw.partition(".")
        frac_part = frac_part.rstrip("0") or ""
        head = _int_to_zh(int(int_part)) if int_part else _DIGITS_ZH[0]
        if not frac_part:
            text = head
        else:
            text = head + "点" + _digits_to_zh(frac_part)
    else:
        text = _int_to_zh(int(raw)) if raw else _DIGITS_ZH[0]
    return ("负" + text) if negative else text


def _int_str_to_zh(raw: str) -> str:
    """Integer-only helper used for 年/月/日/元 where a decimal is impossible."""
    raw = raw.replace(",", "").replace("，", "").strip()
    return _int_to_zh(int(raw)) if raw else _DIGITS_ZH[0]


# --------------------------------------------------------------------------- #
# Number / unit spelling
# --------------------------------------------------------------------------- #

# A digit run that is *safe* to expand.
#
# `_NUM_CORE` deliberately starts the match at a non-digit/dot/letter boundary and
# captures the optional sign, so that
#   * `16GB`, `RTX 5070 Ti`, `bakeoff.sh`, `v1.2.3`, `&#1280;` are left alone
#     (digits glued to a Latin letter, or a trailing "." followed by a letter);
#   * `-5` is read as 负五 while `2020-2021` and `1/2` stay literal ranges.
# `-` is in the guards on purpose: it keeps hyphenated identifiers (GPT-4,
# COVID-19, T-1000) literal, while a detached negative number (温度 -5 度) is
# still read as 负五 because the pattern itself consumes the sign.
_NUM_LEAD = r"(?<![A-Za-z0-9_&#.\-])"
_NUM_CORE = r"(?P<num>-?\d[\d,]*(?:\.\d+)?)(?![0-9])"
_NUM_TRAIL_GUARD = r"(?![A-Za-z_.\-])"

#: Digit run carrying every guard, used where a unit follows (元/%/年/月/日).
_SAFE_NUMBER = _NUM_LEAD + _NUM_CORE + _NUM_TRAIL_GUARD


def _safe_number_pattern() -> str:
    """Digit run that is safe to expand, plus the "not a range" guard.

    Excludes digits glued to a Latin letter/``_`` (``16GB``, ``RTX 5070 Ti``,
    ``bakeoff.sh``, ``v1.2.3``) and digits in a range or fraction
    (``2020-2021``, ``1/2``), which are left for the English voice or for a
    domain-specific reader this module does not have.
    """
    return _SAFE_NUMBER + r"(?!\s*[-–—/~]\s*\d)"


_RE_MONEY = re.compile(
    _safe_number_pattern() + r"\s*元(?!素|件|旦)"
)
_RE_PERCENT = re.compile(
    _safe_number_pattern() + r"\s*[%％]"
)
_RE_YEAR = re.compile(r"(?<![A-Za-z0-9_&#.])(\d{4})(?=\s*年)")
_RE_MONTH = re.compile(r"(?<![A-Za-z0-9_&#.])(\d{1,2})(?!\d)(?=\s*月)")
_RE_DAY = re.compile(r"(?<![A-Za-z0-9_&#.])(\d{1,2})(?!\d)(?=\s*[日号])")
_RE_CARDINAL = re.compile(_safe_number_pattern())

#: Numeric range with an ASCII hyphen: parked so neither half is expanded.
_RE_NUM_RANGE = re.compile(r"(?<![\w.])\d[\d,]*(?:\.\d+)?\s?-\s?\d[\d,]*(?:\.\d+)?(?![\w.])")
#: Fraction / ratio such as ``1/2`` or ``16/9``: parked for the same reason.
#: Reading it as 二分之一 is wrong for "16/9 画幅", so it is left literal.
_RE_FRACTION = re.compile(r"(?<![\w.])\d[\d,]*(?:\.\d+)?\s?/\s?\d[\d,]*(?:\.\d+)?(?![\w.])")

# Percent words already written as Chinese must not be re-prefixed on a second
# pass (idempotence) -- and a literal "百分之3.5" must still be completed.
_PERCENT_ZH = "百分之"


def _money_repl(match: re.Match[str]) -> str:
    return _number_str_to_zh(match.group("num")) + "元"


def _percent_repl(match: re.Match[str]) -> str:
    prefix = match.string[: match.start()].rstrip()
    spoken = _number_str_to_zh(match.group("num"))
    if prefix.endswith(_PERCENT_ZH):
        # "百分之3.5%" would otherwise become 百分之百分之三点五
        return spoken
    return _PERCENT_ZH + spoken


def _year_repl(match: re.Match[str]) -> str:
    """Years are spoken digit-by-digit: 2026年 -> 二零二六年."""
    return _digits_to_zh(match.group(1))


def _month_repl(match: re.Match[str]) -> str:
    return _int_str_to_zh(match.group(1))


def _day_repl(match: re.Match[str]) -> str:
    return _int_str_to_zh(match.group(1))


def _cardinal_repl(match: re.Match[str]) -> str:
    return _number_str_to_zh(match.group("num"))


def _join_number_units(text: str, *, rounds: int = 4) -> str:
    """Close the gap between a number and the measure word that follows it.

    ``2026 年 9 月 11 日`` and the spelled-out ``二零二六 年 九 月 十一 日`` both
    become ``二零二六年九月十一日``.  Only a space between a *number* and one of
    :data:`_MEASURE_WORDS` is removed -- never a space between two CJK words -- so
    no legitimate Chinese text is altered.

    The rules are re-applied until they stop changing the text (bounded by
    ``rounds``) because a single pass cannot close a chain such as
    ``10 点 30 分``: closing "点" exposes the juxtaposition that lets the next
    round close "分".  The result reaches a fixed point, which is what makes
    :func:`spell_out_numbers` idempotent.
    """
    for _ in range(rounds):
        before = text
        text = _RE_SPACE_BEFORE_UNIT.sub("", text)
        text = _RE_SPACE_AFTER_UNIT.sub(r"\1", text)
        if text == before:
            break
    return text


def spell_out_numbers(text: str, lang: str = "zh") -> str:
    """Rewrite Arabic numerals as spoken Chinese.

    Rules (all covered by tests)::

        2026年        -> 二零二六年      (digit-by-digit: correct for years)
        9月11日       -> 九月十一日       (cardinal, not digit-by-digit)
        1280元        -> 一千二百八十元
        3.5%          -> 百分之三点五
        1280          -> 一千二百八十
        3.5           -> 三点五
        -5            -> 负五
        1,280         -> 一千二百八十

    ``lang`` only accepts ``"zh"``; other values are ignored on purpose.  Latin
    text is never touched and digits glued to Latin letters or a dotted version
    (``16GB``, ``bakeoff.sh``, ``v1.2.3``) or inside ranges (``2020-2021``,
    ``1/2``) are left alone -- see the module docstring.  Spaces around known
    measure words (年/月/日/号/元/%/岁/分钟/公里...) are closed, so the result is
    idempotent.
    """
    if lang != "zh":
        return text

    # Numeric ranges are protected before anything else, because the guards that
    # keep "2020-2021" literal are per-number lookarounds: after "2020" is
    # (correctly) skipped, the "2021" half would still be expanded on its own and
    # "2020-二零二一年" is worse than either.  The separator is parked in a
    # private placeholder and restored at the end, so "3-5天" stays "3-5天" and
    # the caller's own formatting is preserved exactly.
    ranges: list[str] = []

    def _protect(match: re.Match[str]) -> str:
        ranges.append(match.group(0))
        return f"\x01R{len(ranges) - 1}\x01"

    text = _RE_NUM_RANGE.sub(_protect, text)
    text = _RE_FRACTION.sub(_protect, text)

    text = _RE_MONEY.sub(_money_repl, text)
    text = _RE_PERCENT.sub(_percent_repl, text)
    text = _RE_YEAR.sub(_year_repl, text)
    text = _RE_MONTH.sub(_month_repl, text)
    text = _RE_DAY.sub(_day_repl, text)
    text = _RE_CARDINAL.sub(_cardinal_repl, text)
    text = _join_number_units(text)
    for index, original in enumerate(ranges):
        text = text.replace(f"\x01R{index}\x01", original)
    return text


#: Sentence boundaries used to decide *per sentence* whether digits are read as
#: Chinese.  Only CJK/full-width enders and newlines: a Latin "." also ends a
#: sentence, but splitting on it would tear "3.5" apart, and a Latin sentence is
#: never one we are about to spell anyway.
_RE_ZH_SENTENCE_SPLIT = re.compile(r"([。！？；…\n]+)")


def _spells_as_chinese(piece: str) -> bool:
    """Whether digits in ``piece`` should be read as Chinese numbers.

    A piece with neither Latin letters nor CJK (a bare ``3.5``) is spelled: there
    is no evidence of another language and that is the historical behaviour the
    existing tests pin down.  Everything else is decided by
    :func:`_text_prefers_zh`, so English prose containing one Chinese loanword
    stays English.
    """
    if not re.search(r"[A-Za-z]", piece) and not any(_is_cjk(ch) for ch in piece):
        return True
    return _text_prefers_zh(piece)


def spell_zh_sentences(text: str) -> str:
    """Spell digits in Chinese sentences only, leaving other languages alone.

    Spelling digits as Chinese was applied to *every* engine that cannot read
    them natively, unconditionally and with ``lang="zh"``.  On Latin text that is
    actively destructive, because the Chinese rules parse Latin conventions the
    other way round: measured on the old code, German ``3,5`` (drei Komma fünf)
    became ``三十五`` (thirty-five) and English ``3.5%`` became ``百分之三点五``.
    CosyVoice then reads Han characters in the middle of a German sentence.

    The fix is per sentence rather than per document, because a Chinese reply
    legitimately contains whole English sentences.  ``re.split`` with a capturing
    group keeps the separators, so the text is reassembled byte-for-byte apart
    from the digits that were intentionally rewritten.
    """
    parts = _RE_ZH_SENTENCE_SPLIT.split(text)
    for index in range(0, len(parts), 2):
        piece = parts[index]
        if piece and _spells_as_chinese(piece):
            parts[index] = spell_out_numbers(piece, lang="zh")
    return "".join(parts)


# --------------------------------------------------------------------------- #
# Markdown / agent-output stripping
# --------------------------------------------------------------------------- #

_RE_FENCE = re.compile(
    r"^[ \t]{0,3}(?P<fence>`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]{0,3}(?P=fence)[ \t]*$|\Z)",
    re.MULTILINE | re.DOTALL,
)
_RE_FENCE_UNCLOSED = re.compile(r"^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*(?:\n.*)?\Z", re.MULTILINE | re.DOTALL)
_RE_IMAGE = re.compile(r"!\[(?P<alt>[^\]]*)\]\([^)]*\)")
_RE_LINK = re.compile(r"(?<!!)\[(?P<text>[^\]]*)\]\(\s*[^)\s]*(?:\s+\"[^\"]*\")?\s*\)")
_RE_REF_LINK = re.compile(r"(?<!!)\[(?P<text>[^\]]+)\]\[[^\]]*\]")
# Character class stops at whitespace, brackets, quotes and CJK/full-width
# characters so a trailing "。" or a Chinese word after the URL is not swallowed.
_RE_URL = re.compile(
    r"<?\b(?:https?://|www\.)[^\s<>()\[\]{}\"'`，、。；：！？（）【】《》“”‘’]+>?",
    re.IGNORECASE,
)
# The URL pattern also stops before a space; that space is markup-removal
# residue and is dropped with the URL (see the _url_repl comment).
_RE_URL_TRAILING_SPACE = re.compile(re.escape(URL_PLACEHOLDER_ZH) + r"[ \t\u00a0\u3000]+")
_RE_HTML_TAG = re.compile(r"</?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?/?>")
_RE_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_RE_INLINE_CODE = re.compile(r"(?P<tick>`+)(?P<body>.+?)(?P=tick)", re.DOTALL)
_RE_HR = re.compile(
    r"^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$", re.MULTILINE
)
_RE_LIST = re.compile(r"^[ \t]{0,3}(?:[-*+•]|\d{1,3}[.)])[ \t]+(?=\S)", re.MULTILINE)
_RE_ATX = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+(?P<body>.+?)[ \t]*#*[ \t]*$", re.MULTILINE)
_RE_SETEXT = re.compile(r"^[ \t]{0,3}(?:=+|-{2,})[ \t]*$", re.MULTILINE)
_RE_BLOCKQUOTE = re.compile(r"^[ \t]{0,3}>[ \t]?", re.MULTILINE)
_RE_TABLE_ROW = re.compile(r"^[ \t]*\|.*\|[ \t]*$", re.MULTILINE)
_RE_TABLE_SEP = re.compile(r"^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$", re.MULTILINE)
_RE_BOLD_ITALIC = re.compile(r"\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*|___(?=\S)(.+?)(?<=\S)___", re.DOTALL)
_RE_BOLD = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__", re.DOTALL)
_RE_ITALIC = re.compile(r"\*(?=\S)([^*\n]+?)(?<=\S)\*|(?<![A-Za-z0-9_])_(?=\S)([^_\n]+?)(?<=\S)_(?![A-Za-z0-9_])")
_RE_STRIKE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~", re.DOTALL)
_RE_CODE_DOLLAR = re.compile(r"(?m)^(?P<indent>[ \t]*)\$[ \t]+(?P<cmd>[^\n]+)$")
_RE_FLAG = re.compile(r"(?<![#\w-])--(?P<flag>[A-Za-z0-9][A-Za-z0-9_-]*(?:=[^\s,，。；;]+)?)")
_RE_PROMPT = re.compile(r"(?<![0-9])\s*[»›]\s+")
_RE_LEFT_BACKTICKS = re.compile(r"`+")
_RE_TABLE_ESCAPED_PIPE = re.compile(r"\\\|")
_RE_MULTI_SPACE = re.compile(r"[ \t\u00a0\u3000]{2,}")
_RE_SPACE_BEFORE_PUNCT = re.compile(r"[ \t]+([，。、；：？！）】》”’％%])")
_RE_SPACE_AFTER_PUNCT = re.compile(r"([（【《“‘])[ \t]+")
_RE_SPACE_AROUND_NEWLINE = re.compile(r"[ \t]*\n[ \t]*")
_RE_MULTI_NEWLINE = re.compile(r"\n{3,}")
_RE_ORPHAN_MARKERS = re.compile(r"(?m)^[ \t]*(?:\*{1,3}|_{1,3}|~~|#{1,6}|-{1,2}|\+)[ \t]*$")

# "2026 年 9 月 11 日" -> "2026年9月11日".  Only a space between a *number* and a
# known measure word is removed, never a space between two CJK words, so no
# legitimate Chinese text is altered.  The spelled-out forms ("二零二六 年",
# "十 分钟") are joined by the same rule, which is why it runs again in
# prepare_for_tts() and inside spell_out_numbers().  Effect: "二零二六年九月十一日"
# instead of a spoken pause at every space.
# Longer measure words come first so "分钟" wins over the bare "分".
_NUM_TAIL = r"[0-9零一二三四五六七八九十百千万亿]"
_MEASURE_WORDS = (
    "分钟", "公里", "公斤", "千米", "小时", "个月", "周岁",
    "年", "月", "日", "号", "元", "圆", "圓", "%", "％",
    "岁", "点", "分", "秒", "个", "家", "次", "层", "楼", "米", "克", "吨", "人",
)
_UNIT_ALT = "(?:" + "|".join(_MEASURE_WORDS) + ")"
#: Units that chain into the next number ("2026 年 9 月 11 日", "10 点 30 分"), so
#: the space after them must go too.  Units not listed here (分钟, 公里...) end
#: their number phrase, and a following number is usually a new phrase.
_CHAIN_UNITS = "年月日号岁点分秒个人家次层楼米克吨元圆圓"
_RE_CHAIN_ALT = "(?:" + "|".join(_CHAIN_UNITS) + ")"
# Both sides of a measure word are zero-width assertions: writing the word into
# the consuming pattern made the substitution delete the word itself
# ("10 分钟" -> "十"), because the replacement replaces everything the pattern ate.
_RE_SPACE_BEFORE_UNIT = re.compile(r"(?<=" + _NUM_TAIL + r")[ \t]+(?=" + _UNIT_ALT + r")")
# This one captures the unit and re-emits it, because a lookbehind cannot express
# "any of these alternative units" and the earlier group-free version deleted the
# unit together with the space ("2026 年 9 月" -> "二零二六九").
_RE_SPACE_AFTER_UNIT = re.compile(
    r"(?<=" + _NUM_TAIL + r")(" + _RE_CHAIN_ALT + r")[ \t]+(?=[0-9]|[\u4e00-\u9fff])"
)


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0x3040 <= code <= 0x30FF
    )


def _text_prefers_zh(text: str) -> bool:
    """True when the text is predominantly Chinese.

    Compares CJK *characters* against Latin *words* with a ratio threshold, not
    raw letters against raw characters: a single URL
    (``https://example.com/docs``) carries more Latin letters than a whole Chinese
    sentence has characters, and comparing those directly made Chinese text with
    a link look like English -- which then silently dropped the spoken placeholder
    instead of saying 链接.  A 0.3 ratio keeps English prose with a stray CJK word
    classified as English while Chinese prose with embedded English terms (the
    normal case for these agent replies) stays Chinese.
    """
    cjk = sum(1 for ch in text if _is_cjk(ch))
    latin_words = len(re.findall(r"[A-Za-z]+", text))
    total = cjk + latin_words
    if total == 0:
        return False
    return (cjk / total) >= 0.3


def link_replaced(url: str, zh: bool) -> str:
    """What a dropped bare URL becomes: a spoken placeholder in Chinese text."""
    return URL_PLACEHOLDER_ZH if zh else ""


def strip_markdown(text: str) -> str:
    """Remove Markdown / agent-reply markup so it is not read aloud.

    Drops: fenced code blocks *and their content*, pipe-table rows, HTML tags and
    comments, ATX headings markers (text is kept), setext underlines, blockquote
    and list markers, horizontal rules.  Keeps: the inner text of bold/italic
    and inline ``code`` spans, link text, image alt text.  Bare URLs become
    ``链接`` in Chinese text and disappear in Latin text.

    Mid-sentence ``*``/``#`` characters that are not real markup -- ``今天 * 明天``,
    ``2026 # 1`` -- are preserved, as is a legitimate ``#`` with no space after it
    (``C#``, ``#1``) so that content characters are never eaten.
    """
    if not text:
        return ""

    zh = _text_prefers_zh(text)
    out = text.replace("\r\n", "\n").replace("\r", "\n")

    # 1. Fenced code blocks: remove the fence and everything between the fences.
    blocks: list[str] = []

    def _capture(match: re.Match[str]) -> str:
        blocks.append(match.group(0))
        return f"\n\x00CODEBLOCK{len(blocks) - 1}\x00\n"

    out = _RE_FENCE.sub(_capture, out)
    # an unclosed fence swallows the rest of the document -- that is intended
    out = _RE_FENCE_UNCLOSED.sub("\n", out)
    out = re.sub(r"\n\x00CODEBLOCK\d+\x00\n", "\n", out)

    # 2. Images and links: keep the human-readable part, drop the target.
    out = _RE_IMAGE.sub(lambda m: m.group("alt"), out)
    out = _RE_LINK.sub(lambda m: m.group("text"), out)
    out = _RE_REF_LINK.sub(lambda m: m.group("text"), out)

    # 3. Bare URLs (after link syntax so link targets are already gone).  A
    #    trailing "。"/"." belongs to the sentence, not to the URL: CJK and
    #    full-width punctuation is excluded by the pattern, and a trailing ASCII
    #    "." or "," is put back exactly once.
    def _url_repl(match: re.Match[str]) -> str:
        url = match.group(0)
        trailing = ""
        if url.endswith((".", ",")):
            url, trailing = url[:-1], url[-1]
        return link_replaced(url, zh) + trailing

    out = _RE_URL.sub(_url_repl, out)
    # "主页在 https://x 上" -> "主页在链接 上"; the space isolated the URL and
    # must go with it, otherwise the placeholder floats away from the sentence.
    out = _RE_URL_TRAILING_SPACE.sub(URL_PLACEHOLDER_ZH, out)

    # 4. HTML comments and tags.
    out = _RE_HTML_COMMENT.sub(" ", out)
    out = _RE_HTML_TAG.sub(" ", out)

    # 5. Pipe tables: drop rows and the header separator entirely.
    out = _RE_TABLE_SEP.sub("", out)
    out = _RE_TABLE_ROW.sub("", out)

    # 6. Inline code spans: keep the payload, lose the backticks.
    out = _RE_INLINE_CODE.sub(lambda m: m.group("body").strip(), out)
    out = _RE_LEFT_BACKTICKS.sub("", out)

    # 7. Horizontal rules and setext underlines (before list markers, which
    #    would otherwise eat a `---` line).  A removed setext underline leaves
    #    "标题\n\n正文" rather than a hard break.
    out = _RE_HR.sub("", out)
    out = _RE_SETEXT.sub("", out)
    # A deleted setext underline leaves its own blank line behind, so
    # "标题\n=====\n正文" would come out as "标题\n\n\n正文".  Three consecutive
    # newlines can only be that residue, so merging them is safe and does not
    # touch a genuine one-blank-line paragraph break.
    out = _RE_MULTI_NEWLINE.sub("\n\n", out)

    # 8. Blockquote and list markers, then heading markers.
    out = _RE_BLOCKQUOTE.sub("", out)
    out = _RE_LIST.sub("", out)
    out = _RE_ATX.sub(lambda m: m.group("body"), out)

    # 9. Emphasis / strikethrough markers.
    out = _RE_BOLD_ITALIC.sub(lambda m: m.group(1) or m.group(2) or "", out)
    out = _RE_BOLD.sub(lambda m: m.group(1) or m.group(2) or "", out)
    out = _RE_ITALIC.sub(lambda m: m.group(1) or m.group(2) or "", out)
    out = _RE_STRIKE.sub(lambda m: m.group(1), out)

    # 10. Shell prompts, trailing prompts, CLI flags: drop the symbol, keep the
    #     alphanumeric payload as plain text.
    out = _RE_CODE_DOLLAR.sub(lambda m: m.group("indent") + m.group("cmd"), out)
    out = _RE_FLAG.sub(lambda m: m.group("flag"), out)
    out = _RE_PROMPT.sub(" ", out)

    # 11. Whitespace hygiene -- never touch CJK punctuation, only the space
    #     introduced by removing markup.  The order matters: line stripping comes
    #     before the blank-line collapse, otherwise a line that still carries a
    #     tab or space survives as "not blank" and blocks the collapse.
    out = _RE_TABLE_ESCAPED_PIPE.sub("|", out)
    out = _RE_SPACE_AROUND_NEWLINE.sub("\n", out)
    out = _RE_SPACE_BEFORE_PUNCT.sub(r"\1", out)
    out = _RE_SPACE_AFTER_PUNCT.sub(r"\1", out)
    out = _RE_MULTI_SPACE.sub(" ", out)
    out = _RE_SPACE_BEFORE_UNIT.sub("", out)
    out = _RE_SPACE_AFTER_UNIT.sub(r"\1", out)
    out = "\n".join(line.rstrip() for line in out.split("\n"))
    out = _RE_ORPHAN_MARKERS.sub("", out)
    out = _RE_MULTI_NEWLINE.sub("\n\n", out)
    return out.strip()


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

#: Engines whose text frontend cannot be relied upon, so digits are pre-expanded.
SPELL_DEFAULT: dict[str, bool] = {
    "generic": False,
    "f5tts": True,        # measured: 2026年 -> "236年", 1280元 -> garbled
    "cosyvoice": True,    # pynini + ttsfrd both missing from its venv
    "cosyvoice3": True,   # shares the CosyVoice 2 venv, so the same frontend is missing
    "indextts": False,    # measured CER 0.0000 on the reference sentence
    "kokoro": False,      # measured CER 0.0000 with native digit handling
}


def prepare_for_tts(
    text: str,
    engine: str = "generic",
    markdown: bool = True,
    spell: bool | None = None,
) -> str:
    """Compose markdown stripping and digit spelling for one engine.

    ``engine`` selects the default digit handling from :data:`SPELL_DEFAULT`
    (``f5tts``/``cosyvoice`` expand digits; ``kokoro``/``indextts``/``generic``
    leave them alone).  ``spell`` overrides that default in either direction.

    ``markdown=True`` always strips markup first, because *every* engine reads
    markup as garbage (measured CER 0.0652 for Kokoro on an agent reply).
    """
    if not text:
        return ""

    if markdown:
        text = strip_markdown(text)

    enable = SPELL_DEFAULT.get(engine.lower(), False) if spell is None else spell
    if enable:
        text = spell_zh_sentences(text)

    # A final light cleanup: digit expansion can leave spaces before a measure
    # word ("二零二六 年") or doubled spaces.
    text = _RE_MULTI_SPACE.sub(" ", text)
    text = _RE_SPACE_BEFORE_UNIT.sub("", text)
    text = _RE_SPACE_AFTER_UNIT.sub(r"\1", text)
    text = _RE_SPACE_AROUND_NEWLINE.sub("\n", text)
    text = _RE_MULTI_NEWLINE.sub("\n\n", text)
    return text.strip()


# --------------------------------------------------------------------------- #
# Segmentation for streaming playback
# --------------------------------------------------------------------------- #

#: Punctuation that ends a sentence; the mark itself stays with that sentence.
_SENTENCE_END = "。！？!?；;…"
#: Trailing characters that belong to the sentence that just ended.
_CLOSERS = "”’」』）)】》〉\"'"
#: Places a too-long sentence may be broken that still sound like a pause.
_SOFT_BREAK = "，,、：: "


#: Month names that turn a preceding ``Zahl.`` into a date rather than a sentence
#: end ("Am 1. Januar", "le 24 décembre").  Without this a German or French date
#: is cut in half and read as two sentences with a pause after a bare number.
_MONTH_NAMES = frozenset((
    # German
    "januar", "februar", "märz", "maerz", "april", "mai", "juni", "juli",
    "august", "september", "oktober", "november", "dezember",
    # French
    "janvier", "février", "fevrier", "avril", "juin", "juillet", "août",
    "aout", "octobre", "novembre", "décembre", "decembre",
    # Spanish / Italian, same ordinal-date shape
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
    "septiembre", "octubre", "noviembre", "diciembre",
    "gennaio", "febbraio", "aprile", "maggio", "giugno", "luglio", "settembre",
    "ottobre", "dicembre",
))

#: Digits immediately before a candidate full stop.
_RE_DIGITS_BEFORE_DOT = re.compile(r"\d+$")
#: First word after a candidate full stop.
_RE_FIRST_WORD_AFTER_DOT = re.compile(r"\s*(\S+)")


def _is_latin_period(text: str, i: int) -> bool:
    """Is ``text[i]`` a full stop that ends a sentence, rather than a decimal point?

    ``.`` only counts after a letter or a digit and before whitespace, so
    ``版本 3.5 很好。`` is not torn apart at the decimal point while ``This is
    fine. Next`` still is.  The *whitespace* requirement is what excludes decimal
    points; the letter requirement is deliberately relaxed to accept digits,
    because a sentence routinely ends in a number (``... im Jahr 2026. Das ist
    viel.``) and demanding a letter left it glued to the following sentence.

    The one false positive that relaxation creates is a Germanic date
    (``Am 1. Januar``), where ``1.`` is an ordinal, not a full stop.  That is
    handled by requiring the digit run to be short *and* the next word to be a
    month name, so ``It was 2026. January was cold.`` still splits.
    """
    if text[i] != "." or i == 0:
        return False
    prev = text[i - 1]
    if not (prev.isascii() and (prev.isalpha() or prev.isdigit())):
        return False
    if i + 1 >= len(text):
        return True
    if not text[i + 1].isspace():
        return False
    if prev.isdigit():
        run = _RE_DIGITS_BEFORE_DOT.search(text[:i])
        if run is not None and len(run.group(0)) <= 2:
            word = _RE_FIRST_WORD_AFTER_DOT.match(text, i + 1)
            if word is not None and word.group(1).strip(".,;:!?").lower() in _MONTH_NAMES:
                return False
    return True


def _split_on_sentence_ends(text: str) -> list[str]:
    """Cut at sentence-final punctuation and newlines, keeping the mark."""
    raw: list[str] = []
    buf: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\n":
            piece = "".join(buf).strip()
            if piece:
                raw.append(piece)
            buf = []
            i += 1
            continue
        buf.append(ch)
        if ch in _SENTENCE_END or _is_latin_period(text, i):
            j = i + 1
            # `……`, `!?` and a closing quote all belong to the sentence just ended.
            while j < n and (text[j] in _SENTENCE_END or text[j] in _CLOSERS):
                buf.append(text[j])
                j += 1
            piece = "".join(buf).strip()
            if piece:
                raw.append(piece)
            buf = []
            i = j
            continue
        i += 1
    piece = "".join(buf).strip()
    if piece:
        raw.append(piece)
    return raw


def _split_long(piece: str, max_chars: int) -> list[str]:
    """Break one over-long sentence at soft pauses; never cut mid-clause."""
    parts: list[str] = []
    while len(piece) > max_chars:
        window = piece[:max_chars]
        cut = 0
        for k in range(len(window) - 1, 0, -1):
            if window[k] in _SOFT_BREAK:
                cut = k + 1
                break
        if cut <= 0:
            # No soft pause inside the window; a hard cut would read as a broken
            # clause, so keep the sentence intact and let the engine handle it.
            break
        parts.append(piece[:cut].strip())
        piece = piece[cut:].strip()
    if piece:
        parts.append(piece)
    return parts


def _join_segments(left: str, right: str) -> str:
    """Glue two segments back together the way the source text had them.

    ``_split_on_sentence_ends`` strips each piece, so the whitespace that used to
    sit between two pieces is gone by the time the short-tail merge runs and
    ``"Ca marche ? Oui."`` came back as ``"Ca marche ?Oui."``.  A space is
    restored only when both boundary characters are ASCII and neither is already
    whitespace: two Chinese segments never take one (``屋子。`` + ``好的。``), and
    an ASCII/CJK boundary is left exactly as the old code had it, so nothing that
    used to be correct can change.
    """
    if not left:
        return right
    if not right:
        return left
    head, tail = left[-1], right[0]
    if head.isascii() and tail.isascii() and not head.isspace() and not tail.isspace():
        return f"{left} {right}"
    return f"{left}{right}"


def segment_text(text: str, max_chars: int = 90, min_chars: int = 8) -> list[str]:
    """Split normalized text into segments that can be synthesized one by one.

    Playback starts after the first segment instead of after the whole reply.
    That matters because the clone engines are slower than real time (measured
    RTF 0.87 for IndexTTS, 1.21 for CosyVoice 3), so a 500-character answer would
    otherwise sit silent for a minute.

    Rules, in order:

    1. cut after ``。！？!?；;…`` and on newlines, keeping the mark;
    2. merge a segment shorter than ``min_chars`` into the previous one, so
       "好的。" does not cost a whole extra synthesis pass;
    3. break a segment longer than ``max_chars`` at the last soft pause
       (``，,、：:``) inside the window — and if there is none, leave it whole
       rather than reading a clause broken in half.

    Call this *after* :func:`prepare_for_tts`, so markdown has already been
    removed and a stray ``#`` or backtick cannot end up as its own segment.
    """
    if not text or not text.strip():
        return []

    merged: list[str] = []
    for piece in _split_on_sentence_ends(text):
        if merged and len(piece) < min_chars:
            merged[-1] = _join_segments(merged[-1], piece)
        else:
            merged.append(piece)

    out: list[str] = []
    for piece in merged:
        out.extend(_split_long(piece, max_chars))
    return [s for s in out if s]


# --------------------------------------------------------------------------- #
# CLI: pipe filter
# --------------------------------------------------------------------------- #

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="textnorm.py",
        description=(
            "Normalize text for the local TTS engines installed under .runtime/tts. "
            "Reads stdin, writes stdout: python textnorm.py --engine f5tts --markdown < in.txt"
        ),
    )
    parser.add_argument(
        "--engine",
        default="generic",
        choices=sorted(SPELL_DEFAULT),
        help="target engine; selects the default digit handling (default: generic)",
    )
    parser.add_argument("--markdown", dest="markdown", action="store_true", default=True,
                        help="strip markdown/code/URLs (default: on)")
    parser.add_argument("--no-markdown", dest="markdown", action="store_false",
                        help="keep markdown as-is")
    parser.add_argument("--spell", dest="spell", action="store_true", default=None,
                        help="force digit spelling on")
    parser.add_argument("--no-spell", dest="spell", action="store_false", default=None,
                        help="force digit spelling off")
    parser.add_argument("--in", dest="infile", default=None, help="input file (default: stdin)")
    parser.add_argument("--out", dest="outfile", default=None, help="output file (default: stdout)")
    parser.add_argument(
        "--segments",
        dest="segments",
        action="store_true",
        default=False,
        help=(
            "emit JSON {engine, spell, normalized, segments} instead of plain text. "
            "Used by the read-aloud host half, which needs the per-sentence split "
            "without waiting for a TTS model to load."
        ),
    )
    parser.add_argument("--max-chars", dest="max_chars", type=int, default=90,
                        help="with --segments: break longer sentences at a soft pause (default 90)")
    parser.add_argument("--min-chars", dest="min_chars", type=int, default=8,
                        help="with --segments: merge shorter sentences forward (default 8)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.infile:
        with open(args.infile, "r", encoding="utf-8") as handle:
            raw = handle.read()
    else:
        raw = sys.stdin.read()
    result = prepare_for_tts(raw, engine=args.engine, markdown=args.markdown, spell=args.spell)
    if args.segments:
        import json

        enable = SPELL_DEFAULT.get(args.engine.lower(), False) if args.spell is None else args.spell
        payload = {
            "engine": args.engine,
            "spell": bool(enable),
            "normalized": result,
            "segments": segment_text(result, max_chars=args.max_chars, min_chars=args.min_chars),
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        sys.stdout.write("\n")
        return 0
    if args.outfile:
        with open(args.outfile, "w", encoding="utf-8") as handle:
            handle.write(result)
    else:
        sys.stdout.write(result)
        if result and not result.endswith("\n"):
            sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
