import { homedir } from 'node:os';
import { join } from 'node:path';

export const VOICE_DATA_HOME = process.env.DSH_VOICE_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'voice');
export const DEFAULT_TTS_ROOT = process.env.DSH_VOICE_TTS_ROOT || join(VOICE_DATA_HOME, 'tts');
export const DEFAULT_MODELS_ROOT = process.env.DSH_VOICE_MODELS_ROOT || join(VOICE_DATA_HOME, 'models', 'tts');
