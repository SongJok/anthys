import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TARGET_BY_EXT: Record<string, { ext: string; filter: string }> = {
  '.ppt': { ext: 'pptx', filter: 'pptx' },
  '.doc': { ext: 'docx', filter: 'docx' },
  '.xls': { ext: 'xlsx', filter: 'xlsx' },
};

const CANDIDATES = [
  'soffice',
  'libreoffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/opt/libreoffice/program/soffice',
];

export interface LegacyConversion {
  buffer: Buffer;
  /** 转换后的文件名（新版扩展名） */
  fileName: string;
}

export interface LegacyConverterOptions {
  /** soffice 可执行文件；默认读取 SOFFICE_PATH，再依次探测常见位置 */
  binary?: string;
  timeoutMs?: number;
}

/** 通过 LibreOffice headless 把 .ppt/.doc/.xls 转为 OOXML；不可用时返回 null */
export async function convertLegacyOffice(
  buffer: Buffer,
  fileName: string,
  options: LegacyConverterOptions = {},
): Promise<LegacyConversion | null> {
  const ext = extname(fileName).toLowerCase();
  const target = TARGET_BY_EXT[ext];
  if (!target) return null;
  const binary = await findBinary(options.binary ?? process.env.SOFFICE_PATH);
  if (!binary) return null;

  const dir = await mkdtemp(join(tmpdir(), 'anthys-convert-'));
  try {
    const input = join(dir, `input${ext}`);
    await writeFile(input, buffer);
    await execFileAsync(
      binary,
      [
        `-env:UserInstallation=file://${join(dir, 'profile')}`,
        '--headless',
        '--convert-to',
        target.filter,
        '--outdir',
        dir,
        input,
      ],
      { timeout: options.timeoutMs ?? 90_000 },
    );
    const output = join(dir, `input.${target.ext}`);
    return {
      buffer: await readFile(output),
      fileName: `${basename(fileName, ext)}.${target.ext}`,
    };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findBinary(preferred: string | undefined): Promise<string | undefined> {
  const list = preferred ? [preferred, ...CANDIDATES] : CANDIDATES;
  for (const candidate of list) {
    if (!candidate.includes('/')) {
      // 裸命令：交给 PATH 解析，用 --version 探测
      try {
        await execFileAsync(candidate, ['--version'], { timeout: 15_000 });
        return candidate;
      } catch {
        continue;
      }
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
