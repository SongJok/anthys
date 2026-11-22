import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAudioFileName,
  OpenAiAudioTranscriber,
  resolveAudioAsrConfig,
} from './AudioTranscriber.js';

describe('AudioTranscriber', () => {
  let dir: string;
  let audioPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anthys-asr-'));
    audioPath = join(dir, 'voice.ogg');
    await writeFile(audioPath, Buffer.from('fake-audio-bytes'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('识别常见音频文件扩展名', () => {
    expect(isAudioFileName('meeting.mp3')).toBe(true);
    expect(isAudioFileName('voice.AMR')).toBe(true);
    expect(isAudioFileName('note.m4a')).toBe(true);
    expect(isAudioFileName('report.pdf')).toBe(false);
  });

  it('通过 OpenAI 兼容 /audio/transcriptions 接口转写音频', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: '帮我查一下今天的订单量' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const transcriber = new OpenAiAudioTranscriber({
      baseUrl: 'https://asr.example.com/v1/',
      apiKey: 'sk-test',
      model: 'SenseVoiceSmall',
      language: 'zh',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const text = await transcriber.transcribe({
      type: 'audio',
      fileName: 'voice.ogg',
      localPath: audioPath,
      size: 16,
    });
    expect(text).toBe('帮我查一下今天的订单量');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://asr.example.com/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    );
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('音频超过体积上限或接口失败时优雅返回 null', async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('upstream error', { status: 502 }),
    );
    const transcriber = new OpenAiAudioTranscriber({
      baseUrl: 'https://asr.example.com/v1',
      apiKey: 'sk-test',
      model: 'whisper-1',
      maxAudioBytes: 8,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn },
    });

    const tooLarge = await transcriber.transcribe({
      type: 'audio',
      fileName: 'voice.ogg',
      localPath: audioPath,
      size: 16,
    });
    expect(tooLarge).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();

    const smallTranscriber = new OpenAiAudioTranscriber({
      baseUrl: 'https://asr.example.com/v1',
      apiKey: 'sk-test',
      model: 'whisper-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn },
    });
    const failed = await smallTranscriber.transcribe({
      type: 'audio',
      fileName: 'voice.ogg',
      localPath: audioPath,
      size: 16,
    });
    expect(failed).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('resolveAudioAsrConfig 正确解析环境变量', () => {
    const cfg = resolveAudioAsrConfig({
      AUDIO_ASR_ENABLED: 'true',
      AUDIO_ASR_BASE_URL: 'https://api.example.com/v1/',
      AUDIO_ASR_API_KEY: 'key-1',
      AUDIO_ASR_MODEL: 'paraformer-v2',
      AUDIO_ASR_TIMEOUT_MS: '45000',
      AUDIO_ASR_MAX_MB: '15',
      AUDIO_ASR_LANGUAGE: 'zh',
    });
    expect(cfg).toEqual({
      enabled: true,
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'key-1',
      model: 'paraformer-v2',
      timeoutMs: 45_000,
      maxAudioBytes: 15 * 1024 * 1024,
      language: 'zh',
    });
  });
});
