#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for :mod:`textnorm` (local TTS text normalization).

Runs two ways::

    python -m pytest -q test_textnorm.py      # if pytest is installed
    python test_textnorm.py                   # plain stdlib runner, no pytest

The assertions cover the numbers that were *measured* to break F5-TTS
(2026年 -> "236年", 1280元 -> garbled, 3.5% -> garbled) and the markdown/code
constructs that were *measured* to be read aloud as garbage (CER 0.0652 on a
realistic agent reply), so a regression here means a real audible regression.
"""

from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from textnorm import (  # noqa: E402
    _digits_to_zh,
    _int_to_zh,
    _number_str_to_zh,
    prepare_for_tts,
    spell_out_numbers,
    strip_markdown,
)

HERE = os.path.dirname(os.path.abspath(__file__))
REFERENCE_TXT = os.path.join(HERE, "reference.txt")

# The measured test sentence.  Kept inline so the test still runs if the file
# moves, but asserted against the real file too (see test_reference_file_matches).
REFERENCE_SENTENCE = (
    "你好，这是本地语音合成测试。今天是 2026 年 9 月 11 日，"
    "芯片价格是 1280 元，涨幅 3.5%。银行行长在行走时遇到了重重困难。"
    "The quick brown fox jumps over the lazy dog."
)

# never converted: the polyphone trap 银行行长/行走/重重 must survive byte-for-byte
POLYPHONE_CLAUSE = "银行行长在行走时遇到了重重困难"


# --------------------------------------------------------------------------- #
# 1. internal numeral helpers
# --------------------------------------------------------------------------- #

def test_int_to_zh_required_cases():
    assert _int_to_zh(120) == "一百二十"
    assert _int_to_zh(1000) == "一千"
    assert _int_to_zh(1005) == "一千零五"
    assert _int_to_zh(10005) == "一万零五"
    assert _int_to_zh(1280) == "一千二百八十"


def test_int_to_zh_tens_and_trailing_zero_rules():
    # 一十 -> 十 when the group starts with the tens digit
    assert _int_to_zh(10) == "十"
    assert _int_to_zh(11) == "十一"
    assert _int_to_zh(15) == "十五"
    assert _int_to_zh(20) == "二十"
    # but the 一 is kept once a larger unit precedes it: 100 < 110 < 120
    assert _int_to_zh(110) == "一百一十"
    assert _int_to_zh(120) == "一百二十"
    # trailing zeros inside a group are dropped without a stray 零
    assert _int_to_zh(100) == "一百"
    assert _int_to_zh(1000) == "一千"
    assert _int_to_zh(1010) == "一千零一十"
    assert _int_to_zh(1100) == "一千一百"
    # zeros between non-zero digits collapse to a single 零
    assert _int_to_zh(1005) == "一千零五"
    assert _int_to_zh(1015) == "一千零一十五"
    assert _int_to_zh(10005) == "一万零五"
    assert _int_to_zh(0) == "零"


def test_int_to_zh_wan_and_yi_grouping():
    assert _int_to_zh(10000) == "一万"
    assert _int_to_zh(12800) == "一万二千八百"
    assert _int_to_zh(100000) == "十万"
    assert _int_to_zh(1000000) == "一百万"
    assert _int_to_zh(10000000) == "一千万"
    assert _int_to_zh(100000000) == "一亿"
    assert _int_to_zh(100000001) == "一亿零一"
    # 1,100,000,000 is read 十一亿 (cf. the written "11亿"), not 一十一亿: the 一 is
    # dropped whenever the 一十 opens its group, keeping 一 only after a unit
    # inside the same group (110 -> 一百一十).
    assert _int_to_zh(1100000000) == "十一亿"
    assert _int_to_zh(11000000000) == "一百一十亿"
    # a 一十 in a non-top group keeps its 一 as well
    assert _int_to_zh(100015) == "十万零一十五"
    assert _int_to_zh(1100000) == "一百一十万"
    assert _int_to_zh(-1280) == "负一千二百八十"


def test_digits_to_zh():
    assert _digits_to_zh("2026") == "二零二六"
    assert _digits_to_zh("09") == "零九"
    assert _digits_to_zh("") == ""


def test_number_str_to_zh_decimals_separators_and_signs():
    assert _number_str_to_zh("3.5") == "三点五"
    assert _number_str_to_zh("1,280") == "一千二百八十"
    assert _number_str_to_zh("1,280.50") == "一千二百八十点五"
    assert _number_str_to_zh("0.5") == "零点五"
    assert _number_str_to_zh("0.05") == "零点零五"
    assert _number_str_to_zh("-5") == "负五"
    assert _number_str_to_zh("-3.5") == "负三点五"
    assert _number_str_to_zh("3.0") == "三"


# --------------------------------------------------------------------------- #
# 2. spell_out_numbers -- every required case
# --------------------------------------------------------------------------- #

def test_spell_years():
    assert spell_out_numbers("2026年") == "二零二六年"
    assert spell_out_numbers("2026 年") == "二零二六年"
    assert spell_out_numbers("1999年") == "一九九九年"


def test_spell_month_and_day_are_cardinal_not_digits():
    assert spell_out_numbers("9月11日") == "九月十一日"
    assert spell_out_numbers("9 月 11 日") == "九月十一日"
    assert spell_out_numbers("12月1日") == "十二月一日"


def test_spell_date_combination():
    assert spell_out_numbers("2026年9月11日") == "二零二六年九月十一日"
    assert "二零二六年" in spell_out_numbers("今天是 2026 年 9 月 11 日")


def test_spell_money():
    assert spell_out_numbers("1280元") == "一千二百八十元"
    assert spell_out_numbers("1280 元") == "一千二百八十元"
    assert spell_out_numbers("1,280元") == "一千二百八十元"
    assert "一千二百八十元" in spell_out_numbers("芯片价格是 1280 元。")


def test_spell_percent():
    assert spell_out_numbers("3.5%") == "百分之三点五"
    assert spell_out_numbers("3.5 %") == "百分之三点五"
    assert spell_out_numbers("100%") == "百分之一百"
    assert spell_out_numbers("３.５％".replace("３", "3").replace("５", "5")) == "百分之三点五"
    # an already-literary "百分之3.5" must not become 百分之百分之
    assert spell_out_numbers("百分之3.5%") == "百分之三点五"


def test_spell_plain_cardinals_and_decimals():
    assert spell_out_numbers("1280") == "一千二百八十"
    assert spell_out_numbers("120") == "一百二十"
    assert spell_out_numbers("1000") == "一千"
    assert spell_out_numbers("1005") == "一千零五"
    assert spell_out_numbers("10005") == "一万零五"
    assert spell_out_numbers("3.5") == "三点五"


def test_spell_negatives_and_thousands_separators():
    assert spell_out_numbers("-5") == "负五"
    assert spell_out_numbers("温度 -5 度") == "温度 负五 度"
    assert spell_out_numbers("1,280") == "一千二百八十"
    assert spell_out_numbers("12,345,678") == "一千二百三十四万五千六百七十八"


def test_spell_leaves_latin_and_mixed_tokens_alone():
    # digits glued to Latin letters, or following a dotted version, belong to the
    # English voice / a domain reader: they must survive byte-for-byte
    for token in ["16GB", "bakeoff.sh", "v1.2.3", "3.5.1", "GPT-4", "sm_120"]:
        out = spell_out_numbers(f"使用 {token} 完成。")
        assert token in out, f"{token!r} was mangled into {out!r}"
    # ranges and fractions stay literal rather than becoming negative numbers
    assert "2020-2021" in spell_out_numbers("2020-2021 年")
    assert "1/2" in spell_out_numbers("1/2 概率")
    # a standalone number next to Latin words IS expanded -- documented choice:
    # "RTX 5070 Ti" -> "RTX 五千零七十 Ti" is safer for an engine with no
    # text frontend than leaving "5070" to be guessed at.
    assert spell_out_numbers("RTX 5070 Ti") == "RTX 五千零七十 Ti"
    # Latin prose untouched
    assert spell_out_numbers("The quick brown fox jumps over the lazy dog.") == (
        "The quick brown fox jumps over the lazy dog."
    )


def test_spell_preserves_chinese_punctuation():
    text = "你好，这是测试。问题：对吗？对！"
    assert spell_out_numbers(text) == text


def test_spell_ten_as_shi_not_yi_shi():
    # the 一十 -> 十 collapse in the leading position: this is where the bug was
    # audible, because "10月" must not be read 一十月
    assert _int_to_zh(10) == "十"
    assert _int_to_zh(11) == "十一"
    assert _int_to_zh(15) == "十五"
    assert _int_to_zh(100000) == "十万"
    assert _int_to_zh(10000000) == "一千万"
    assert _int_to_zh(1100000000) == "十一亿"
    assert spell_out_numbers("10月") == "十月"
    assert spell_out_numbers("10日") == "十日"
    assert spell_out_numbers("10%") == "百分之十"
    assert spell_out_numbers("10元") == "十元"
    assert "十月" in spell_out_numbers("2026年10月")
    assert spell_out_numbers("2026年10月") == "二零二六年十月"
    assert spell_out_numbers("110元") == "一百一十元"


def test_spell_united_number_cases_from_real_replies():
    assert spell_out_numbers("100000元") == "十万元"
    assert spell_out_numbers("15岁") == "十五岁"
    assert spell_out_numbers("第10章") == "第十章"
    assert spell_out_numbers("10公里") == "十公里"
    assert spell_out_numbers("10 公里") == "十公里"
    assert spell_out_numbers("耗时 10 分钟") == "耗时 十分钟"
    assert spell_out_numbers("上午 10 点 30 分") == "上午 十点三十分"
    # a chained date keeps every unit: 年/月/日 must not be eaten by the joiner
    assert spell_out_numbers("2026 年 9 月 11 日") == "二零二六年九月十一日"
    assert "2026年9月11日" in strip_markdown("今天是 2026 年 9 月 11 日。")
    assert spell_out_numbers("今天是 2026 年 9 月 11 日。") == "今天是 二零二六年九月十一日。"


def test_spell_units_and_latin_acronyms_do_not_mangle():
    # RTF 1.4 -> the acronym is untouched, the value is spoken
    mixed = "共 3 个引擎，耗时 10 分钟，占 1280MB 显存，RTF 1.4"
    out = spell_out_numbers(mixed)
    assert "RTF 一点四" in out, out
    assert "三个引擎" in out, out
    assert "十分钟" in out, out
    # MB/GB stay Latin: 1280MB is a memory size the English voice reads, and
    # spelling it as 一千二百八十兆字节 would be worse in practice
    assert "1280MB" in out, out
    assert spell_out_numbers("16GB 显存") == "16GB 显存"


def test_spell_is_idempotent():
    once = spell_out_numbers("今天的 2026 年 9 月 11 日价格是 1280 元，涨幅 3.5%，第 120 号。")
    twice = spell_out_numbers(once)
    assert twice == once, f"not idempotent:\n 1x={once!r}\n 2x={twice!r}"
    for probe in ["2026 年 9 月 11 日", "上午 10 点 30 分", "耗时 10 分钟", "10月", "3 个"]:
        first = spell_out_numbers(probe)
        assert spell_out_numbers(first) == first, probe


def test_spell_ignores_non_zh_lang():
    assert spell_out_numbers("1280元", lang="en") == "1280元"


# --------------------------------------------------------------------------- #
# 3. strip_markdown
# --------------------------------------------------------------------------- #

def test_fenced_code_block_removed_entirely():
    md = "前面的句子。\n\n```python\nprint('hello')\nx = 1280 元\n```\n\n后面的句子。"
    out = strip_markdown(md)
    assert "```" not in out
    assert "print" not in out and "1280" not in out and "hello" not in out
    assert "前面的句子。" in out and "后面的句子。" in out


def test_tilde_fence_and_language_tag_removed():
    md = "开始。\n\n~~~bash\nnvidia-smi --query-gpu=name\n~~~\n\n结束。"
    out = strip_markdown(md)
    assert "~~~" not in out and "nvidia-smi" not in out
    assert "开始。" in out and "结束。" in out


def test_unclosed_fence_swallows_the_rest():
    out = strip_markdown("保留这句。\n\n```python\nprint(1)\nprint(2)")
    assert "保留这句。" in out
    assert "print" not in out and "```" not in out


def test_bold_keeps_inner_text():
    assert strip_markdown("这是 **粗体** 文字。") == "这是 粗体 文字。"
    assert strip_markdown("这是 __粗体__ 文字。") == "这是 粗体 文字。"
    assert strip_markdown("这是 ***重点*** 文字。") == "这是 重点 文字。"
    assert strip_markdown("这是 *斜体* 文字。") == "这是 斜体 文字。"
    assert strip_markdown("这是 ~~删除~~ 文字。") == "这是 删除 文字。"


def test_links_keep_text_and_drop_target():
    assert strip_markdown("见 [docs](https://example.com) 说明。") == "见 docs 说明。"


def test_image_keeps_alt_text():
    out = strip_markdown("看图 ![架构图](https://example.com/a.png) 结束。")
    assert "架构图" in out
    assert "a.png" not in out and "http" not in out


def test_bare_url_is_replaced_by_placeholder_in_chinese():
    out = strip_markdown("主页在 https://example.com/docs 上。")
    assert "http" not in out and "example.com" not in out
    assert "链接" in out       # placeholder: the listener is told something was dropped
    assert out.endswith("上。")  # the Chinese word after the URL is not eaten


def test_bare_url_dropped_from_latin_text():
    out = strip_markdown("See https://example.com/docs for details.")
    assert "example.com" not in out and "http" not in out
    assert "See" in out and "for details." in out


def test_atx_heading_keeps_text():
    assert strip_markdown("# Heading") == "Heading"
    assert strip_markdown("## 二级标题") == "二级标题"
    assert strip_markdown("### 三级标题 ###") == "三级标题"


def test_setext_underline_removed():
    assert strip_markdown("标题\n=====\n正文") == "标题\n\n正文"
    assert strip_markdown("标题\n-----\n正文") == "标题\n\n正文"
    # a real paragraph break is still preserved as one blank line
    assert strip_markdown("第一段\n\n第二段") == "第一段\n\n第二段"


def test_blockquote_list_and_hr_markers_removed():
    assert strip_markdown("> 引用一行") == "引用一行"
    assert strip_markdown("- 项目一\n- 项目二") == "项目一\n项目二"
    assert strip_markdown("1. 第一步\n2. 第二步") == "第一步\n第二步"
    assert strip_markdown("上面\n\n---\n\n下面") == "上面\n\n下面"
    assert "---" not in strip_markdown("上面\n\n***\n\n下面")


def test_table_rows_dropped_entirely():
    md = "表格如下：\n\n| 引擎 | CER |\n| --- | --- |\n| f5tts | 0.1463 |\n\n表后文字。"
    out = strip_markdown(md)
    assert "|" not in out
    assert "CER" not in out and "f5tts" not in out
    assert "表格如下：" in out and "表后文字。" in out


def test_html_tags_and_comments_removed():
    out = strip_markdown("<div class='x'>内容</div><!-- 注释 -->完")
    assert "<div" not in out and "注释" not in out
    assert "内容" in out and "完" in out


def test_inline_code_keeps_text_without_backticks():
    out = strip_markdown("运行 `pip install torch` 即可。")
    assert "`" not in out
    assert "pip install torch" in out


def test_mid_sentence_hash_and_star_are_not_corrupted():
    # a mid-sentence "*" used as content must survive untouched
    text = "今天 * 明天都是好日子。"
    assert strip_markdown(text) == text
    # a mid-sentence "#" used as content survives; only the whitespace around the
    # list/heading markers that got removed is normalized ("1 号" -> "1号")
    out = strip_markdown("今天 * 明天都是好日子，2026 # 1 号。")
    assert "*" in out and "#" in out, out
    assert out == "今天 * 明天都是好日子，2026 # 1号。", out
    assert not out.startswith(("*", "#")), out
    # C# / #1 keep their hash because there is no space after it
    assert strip_markdown("用 C# 写代码，见 #1 条目。") == "用 C# 写代码，见 #1 条目。"
    assert strip_markdown("中文句子里有 # 井号作为内容。") == "中文句子里有 # 井号作为内容。"


def test_chinese_punctuation_survives_stripping():
    text = "你好，这是**加粗**的测试：价格 1280 元（含税）。"
    out = strip_markdown(text)
    for mark in "，：（）。":
        assert mark in out, f"lost punctuation {mark!r} in {out!r}"
    assert "**" not in out


def test_shell_prompt_flags_and_paths_are_not_spoken_as_symbols():
    out = strip_markdown("$ nvidia-smi --query-gpu=name\n文件在 /example/scripts/check.sh")
    assert "$" not in out
    assert "--" not in out
    assert "nvidia-smi query-gpu=name" in out
    # an absolute path stays readable text rather than being deleted
    assert "/example/scripts/check.sh" in out


def test_excessive_blank_lines_and_whitespace_collapsed():
    out = strip_markdown("A\n\n\n\n\nB\n\n\n   \n\nC")
    assert "\n\n\n" not in out
    assert out.split("\n\n") == ["A", "B", "C"]
    assert "  " not in out


def test_empty_and_whitespace_inputs():
    assert strip_markdown("") == ""
    assert strip_markdown("   \n\n  ") == ""
    assert prepare_for_tts("") == ""


def test_realistic_agent_reply_end_to_end():
    reply = (
        "# 部署报告\n\n"
        "本次使用 **F5-TTS** 引擎，显存占用 `16GB`。\n\n"
        "```python\nimport torch\nprint(torch.cuda.is_available())\n```\n\n"
        "| 引擎 | CER |\n| --- | --- |\n| f5tts | 0.1463 |\n\n"
        "- 运行 `bakeoff.sh`\n"
        "- 查看 [文档](https://example.com/docs)\n\n"
        "```bash\n$ nvidia-smi --query-gpu=name\n```\n\n"
        "详见 https://example.com/report 。\n"
    )
    out = strip_markdown(reply)
    for junk in ["#", "**", "`", "|", "```", "http", "import torch", "nvidia-smi", "---"]:
        assert junk not in out, f"{junk!r} survived stripping: {out!r}"
    # the human-readable payload must survive
    for kept in ["部署报告", "F5-TTS", "引擎", "运行", "文档"]:
        assert kept in out, f"{kept!r} was lost: {out!r}"
    # the pipe-table row was dropped with the header, not spoken as cell values
    assert "CER" not in out and "0.1463" not in out, out
    # inline code keeps its text, so the memory size is still announced
    assert "16GB" in out, out
    assert "链接" in out, out
    # punctuation survived the stripping
    for mark in "，。":
        assert mark in out, f"lost {mark!r} in {out!r}"



# --------------------------------------------------------------------------- #
# 4. prepare_for_tts -- engine switch and the measured reference sentence
# --------------------------------------------------------------------------- #

def test_prepare_f5tts_expands_the_reference_sentence():
    out = prepare_for_tts(REFERENCE_SENTENCE, engine="f5tts")
    for expected in ["二零二六年", "九月十一日", "一千二百八十元", "百分之三点五"]:
        assert expected in out, f"missing {expected!r} in {out!r}"
    # no raw digits left in the Chinese half
    chinese_part = out.split("The quick brown fox")[0]
    assert not any(ch.isdigit() for ch in chinese_part), f"digits left: {chinese_part!r}"


def test_prepare_reference_polyphone_clause_untouched():
    out = prepare_for_tts(REFERENCE_SENTENCE, engine="f5tts")
    assert POLYPHONE_CLAUSE in out, f"polyphone clause damaged: {out!r}"
    # and byte-for-byte identical to the source span
    start = REFERENCE_SENTENCE.index(POLYPHONE_CLAUSE)
    assert out[out.index(POLYPHONE_CLAUSE):][: len(POLYPHONE_CLAUSE)] == (
        REFERENCE_SENTENCE[start:start + len(POLYPHONE_CLAUSE)]
    )


def test_prepare_cosyvoice_expands_digits_too():
    out = prepare_for_tts(REFERENCE_SENTENCE, engine="cosyvoice")
    assert "二零二六年" in out and "一千二百八十元" in out


def test_prepare_kokoro_leaves_digits_alone_by_default():
    # Kokoro reads digits natively at CER 0.0000; expanding could only regress it.
    out = prepare_for_tts(REFERENCE_SENTENCE, engine="kokoro")
    assert "2026" in out and "3.5%" in out and "1280" in out
    assert "二零二六" not in out


def test_prepare_indextts_and_generic_leave_digits_alone():
    for engine in ["indextts", "generic"]:
        out = prepare_for_tts(REFERENCE_SENTENCE, engine=engine)
        assert "2026" in out, engine


def test_spell_flag_overrides_engine_default_in_both_directions():
    assert "二零二六" in prepare_for_tts(REFERENCE_SENTENCE, engine="kokoro", spell=True)
    assert "2026" in prepare_for_tts(REFERENCE_SENTENCE, engine="f5tts", spell=False)


def test_prepare_strips_markdown_for_every_engine():
    md = "# 标题\n\n```python\nprint(1)\n```\n\n正文 **粗体**。"
    for engine in ["f5tts", "cosyvoice", "kokoro", "indextts", "generic"]:
        out = prepare_for_tts(md, engine=engine)
        assert "```" not in out and "print(1)" not in out and "**" not in out, engine
        assert "标题" in out and "正文 粗体。" in out, engine


def test_markdown_flag_can_be_disabled():
    md = "# 标题"
    assert prepare_for_tts(md, engine="f5tts", markdown=False) == "# 标题"


def test_prepare_is_idempotent_including_markdown():
    source = (
        "# 报告\n\n共 **1280 元**，涨幅 3.5%，见 [docs](https://example.com)。\n\n"
        "```bash\nnvidia-smi\n```\n"
    )
    once = prepare_for_tts(source, engine="f5tts")
    twice = prepare_for_tts(once, engine="f5tts")
    assert twice == once, f"not idempotent:\n 1x={once!r}\n 2x={twice!r}"
    # and stable a third time
    assert prepare_for_tts(twice, engine="f5tts") == once


def test_prepare_reference_sentence_from_disk():
    if not os.path.exists(REFERENCE_TXT):
        return "reference.txt not present; inline copy was still asserted"
    with open(REFERENCE_TXT, encoding="utf-8") as handle:
        on_disk = handle.read().strip()
    assert on_disk == REFERENCE_SENTENCE, (
        "reference.txt changed on disk; update REFERENCE_SENTENCE and re-check the "
        "measured expectations in the module docstring"
    )
    out = prepare_for_tts(on_disk, engine="f5tts")
    assert "二零二六年" in out and "九月十一日" in out
    assert "一千二百八十元" in out and "百分之三点五" in out
    assert POLYPHONE_CLAUSE in out


# --------------------------------------------------------------------------- #
# 5. CLI as a pipe filter
# --------------------------------------------------------------------------- #

def _run_cli(args: list[str], stdin_text: str) -> str:
    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, "textnorm.py"), *args],
        input=stdin_text, capture_output=True, text=True, encoding="utf-8", check=False,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


def test_cli_pipe_filter_with_engine_and_markdown():
    out = _run_cli(["--engine", "f5tts", "--markdown"], "# 标题\n\n共 1280 元，涨幅 3.5%。\n")
    assert "标题" in out and "#" not in out
    assert "一千二百八十元" in out and "百分之三点五" in out


def test_cli_no_spell_and_spell_flags():
    src = "共 1280 元。\n"
    assert "1280" in _run_cli(["--engine", "f5tts", "--no-spell"], src)
    assert "一千二百八十元" in _run_cli(["--engine", "kokoro", "--spell"], src)
    assert "1280" in _run_cli(["--engine", "kokoro"], src)


def test_cli_reference_sentence():
    out = _run_cli(["--engine", "f5tts"], REFERENCE_SENTENCE + "\n")
    assert "二零二六年" in out and "九月十一日" in out
    assert POLYPHONE_CLAUSE in out


# --------------------------------------------------------------------------- #
# 9. digits are spelled only in sentences that read as Chinese
# --------------------------------------------------------------------------- #
# ``prepare_for_tts`` used to call ``spell_out_numbers`` unconditionally with
# ``lang="zh"``, so Latin text was rewritten with Chinese numerals.  Measured on
# the old code: German "3,5" (drei Komma fünf) became 三十五 (thirty-five) and
# English "3.5%" became 百分之三点五 -- CosyVoice then reads Han characters in
# the middle of a German sentence.  These tests pin the boundary both ways.

def test_german_digits_are_left_alone():
    out = prepare_for_tts("Der Preis ist 3,5 Prozent im Jahr 2026.", engine="cosyvoice")
    assert out == "Der Preis ist 3,5 Prozent im Jahr 2026."
    assert "三十五" not in out and "三" not in out


def test_english_digits_are_left_alone():
    out = prepare_for_tts("Growth was 3.5% in 2026.", engine="cosyvoice")
    assert out == "Growth was 3.5% in 2026."
    assert "百分之" not in out


def test_french_digits_are_left_alone():
    out = prepare_for_tts("Le prix est de 3,5 pour cent en 2026.", engine="cosyvoice")
    assert out == "Le prix est de 3,5 pour cent en 2026."


def test_english_abbreviation_is_not_partly_spelled():
    # The old code turned "3 p.m." into "三 p.m.".
    out = prepare_for_tts("The meeting is at 3 p.m. today.", engine="cosyvoice")
    assert out == "The meeting is at 3 p.m. today."


def test_chinese_sentences_still_spell_their_digits():
    assert prepare_for_tts("价格是 3.5%，2026 年发布。", engine="cosyvoice") == \
        "价格是 百分之三点五，二零二六年发布。"
    assert prepare_for_tts("1280 元，9月11日交付。", engine="cosyvoice") == \
        "一千二百八十元，九月十一日交付。"


def test_a_chinese_reply_spells_only_its_chinese_sentence():
    # The decision is per sentence on purpose: a Chinese reply legitimately
    # contains whole English sentences, and those must survive untouched.
    out = prepare_for_tts("价格是 3.5%。The price is 3.5 dollars in 2026.", engine="cosyvoice")
    assert out == "价格是 百分之三点五。The price is 3.5 dollars in 2026."


def test_digits_with_no_letters_at_all_keep_the_legacy_behaviour():
    # "3.5" carries no evidence of another language, so it is still spelled.
    assert prepare_for_tts("3.5", engine="cosyvoice") == "三点五"


def test_prepare_for_latin_text_is_idempotent():
    # The worker re-runs this on every segment it is handed, so a second pass
    # must not change anything.
    once = prepare_for_tts("Growth was 3.5% in 2026.", engine="cosyvoice")
    assert prepare_for_tts(once, engine="cosyvoice") == once


# --------------------------------------------------------------------------- #
# stdlib runner (works without pytest)
# --------------------------------------------------------------------------- #

def _collect_tests() -> list[tuple[str, object]]:
    import __main__ as main_module

    namespace = globals() if main_module.__name__ == "__main__" else None
    module = sys.modules[__name__]
    found = []
    for name in sorted(dir(module)):
        if name.startswith("test_"):
            obj = getattr(module, name)
            if callable(obj):
                found.append((name, obj))
    del namespace
    return found


def _run_all() -> int:
    tests = _collect_tests()
    passed, failed = 0, []
    for name, func in tests:
        try:
            func()
        except AssertionError as exc:
            failed.append((name, f"AssertionError: {exc}"))
        except Exception as exc:  # noqa: BLE001 - report any error, keep going
            failed.append((name, f"{type(exc).__name__}: {exc}"))
        else:
            passed += 1
            print(f"PASS  {name}")
    print()
    if failed:
        print("FAILURES:")
        for name, reason in failed:
            print(f"FAIL  {name}\n        {reason}")
        print()
    print(f"{passed} passed, {len(failed)} failed, {len(tests)} total")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
