import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FfmpegVideoAnalyzer, isVideoFileName } from './VideoAnalyzer.js';

describe('VideoAnalyzer', () => {
  it('识别常见视频扩展名', () => {
    expect(isVideoFileName('screen.mp4')).toBe(true);
    expect(isVideoFileName('demo.MOV')).toBe(true);
    expect(isVideoFileName('doc.docx')).toBe(false);
  });

  it('抽取关键帧与音轨并分别交给视觉和语音模型汇总', async () => {
    const execFfmpeg = vi.fn(async (args: string[]) => {
      const target = args[args.length - 1]!;
      if (target.endsWith('.jpg')) {
        const dir = dirname(target);
        await writeFile(join(dir, 'frame-01.jpg'), Buffer.from('jpg1'));
        await writeFile(join(dir, 'frame-02.jpg'), Buffer.from('jpg2'));
      } else if (target.endsWith('.wav')) {
        await writeFile(target, Buffer.from('wav-bytes'));
      }
    });
    const vision = {
      describe: vi
        .fn()
        .mockResolvedValueOnce('控制台报错 502')
        .mockResolvedValueOnce('重试后依然超时'),
    };
    const audio = {
      transcribe: vi.fn().mockResolvedValue('这里点提交就会卡住'),
    };

    const analyzer = new FfmpegVideoAnalyzer({
      vision,
      audio,
      execFfmpeg,
    });
    const summary = await analyzer.analyze({
      type: 'video',
      fileName: 'bug.mp4',
      localPath: '/tmp/bug.mp4',
      size: 1024,
    });

    expect(summary).toContain('画面 #1：控制台报错 502');
    expect(summary).toContain('画面 #2：重试后依然超时');
    expect(summary).toContain('音轨转写：这里点提交就会卡住');
    expect(vision.describe).toHaveBeenCalledTimes(2);
    expect(audio.transcribe).toHaveBeenCalledTimes(1);
  });

  it('ffmpeg 不可用时静默返回 null 不抛错', async () => {
    const warn = vi.fn();
    const analyzer = new FfmpegVideoAnalyzer({
      vision: { describe: vi.fn() },
      execFfmpeg: vi.fn().mockRejectedValue(new Error('ENOENT')),
      logger: { warn },
    });
    const summary = await analyzer.analyze({
      type: 'video',
      fileName: 'bug.mp4',
      localPath: '/tmp/bug.mp4',
      size: 1024,
    });
    expect(summary).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
