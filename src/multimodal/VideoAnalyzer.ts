import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { StoredAttachment } from './AttachmentStore.js';
import type { AudioTranscriber } from './AudioTranscriber.js';

export interface VideoAnalyzer {
  analyze(
    attachment: StoredAttachment,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
}

export interface FfmpegVideoAnalyzerOptions {
  vision?: {
    describe(
      attachment: StoredAttachment,
      options?: { signal?: AbortSignal },
    ): Promise<string | null>;
  };
  audio?: AudioTranscriber;
  ffmpegBinary?: string;
  maxFrames?: number;
  timeoutMs?: number;
  execFfmpeg?: (args: string[], timeoutMs: number) => Promise<void>;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const DEFAULT_MAX_FRAMES = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export function isVideoFileName(fileName: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function runExecFile(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * 短视频/录屏关键帧与音轨摘要器：
 * 通过受控 ffmpeg（无 shell 拼接）抽取最多 maxFrames 帧静态画面 + 音轨，
 * 复用 VisionDescriber 与 AudioTranscriber 产出可读文本；宿主机未安装 ffmpeg 时静默降级。
 */
export class FfmpegVideoAnalyzer implements VideoAnalyzer {
  private readonly ffmpegBinary: string;
  private readonly maxFrames: number;
  private readonly timeoutMs: number;
  private readonly execFfmpeg: (args: string[], timeoutMs: number) => Promise<void>;

  constructor(private readonly options: FfmpegVideoAnalyzerOptions) {
    this.ffmpegBinary = options.ffmpegBinary ?? process.env.FFMPEG_BINARY?.trim() ?? 'ffmpeg';
    this.maxFrames = Math.min(8, Math.max(1, options.maxFrames ?? DEFAULT_MAX_FRAMES));
    this.timeoutMs = Math.max(3_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.execFfmpeg =
      options.execFfmpeg ?? ((args, timeout) => runExecFile(this.ffmpegBinary, args, timeout));
  }

  public async analyze(
    attachment: StoredAttachment,
    options: { signal?: AbortSignal } = {},
  ): Promise<string | null> {
    if (options.signal?.aborted) return null;
    if (!this.options.vision && !this.options.audio) return null;

    const workDir = await mkdtemp(join(tmpdir(), 'anthys-video-'));
    const sections: string[] = [];
    try {
      if (this.options.vision && !options.signal?.aborted) {
        const framePattern = join(workDir, 'frame-%02d.jpg');
        try {
          await this.execFfmpeg(
            [
              '-y',
              '-i',
              attachment.localPath,
              '-vf',
              'fps=0.5,scale=1024:-2',
              '-frames:v',
              String(this.maxFrames),
              framePattern,
            ],
            this.timeoutMs,
          );
          const files = (await readdir(workDir))
            .filter((name) => name.startsWith('frame-') && name.endsWith('.jpg'))
            .sort()
            .slice(0, this.maxFrames);
          const frameDescriptions: string[] = [];
          for (let i = 0; i < files.length; i += 1) {
            if (options.signal?.aborted) break;
            const fileName = files[i]!;
            const fullPath = join(workDir, fileName);
            const info = await stat(fullPath);
            const desc = await this.options.vision.describe(
              {
                type: 'image',
                fileName,
                localPath: fullPath,
                size: info.size,
                mimeType: 'image/jpeg',
              },
              options.signal ? { signal: options.signal } : undefined,
            );
            if (desc?.trim()) {
              frameDescriptions.push(`画面 #${i + 1}：${desc.trim()}`);
            }
          }
          if (frameDescriptions.length > 0) {
            sections.push(`关键帧识别：\n${frameDescriptions.join('\n')}`);
          }
        } catch (error) {
          this.options.logger?.warn(
            {
              file: attachment.fileName,
              error: error instanceof Error ? error.message : String(error),
            },
            'video keyframe extraction skipped or failed',
          );
        }
      }

      if (this.options.audio && !options.signal?.aborted) {
        const wavPath = join(workDir, 'audio.wav');
        try {
          await this.execFfmpeg(
            [
              '-y',
              '-i',
              attachment.localPath,
              '-vn',
              '-ac',
              '1',
              '-ar',
              '16000',
              wavPath,
            ],
            this.timeoutMs,
          );
          const info = await stat(wavPath);
          if (info.size > 0) {
            const transcript = await this.options.audio.transcribe(
              {
                type: 'audio',
                fileName: 'audio.wav',
                localPath: wavPath,
                size: info.size,
                mimeType: 'audio/wav',
              },
              options.signal ? { signal: options.signal } : undefined,
            );
            if (transcript?.trim()) {
              sections.push(`音轨转写：${transcript.trim()}`);
            }
          }
        } catch {
          // 无音轨或 ffmpeg 不可用时静默跳过
        }
      }

      return sections.length > 0 ? sections.join('\n') : null;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
