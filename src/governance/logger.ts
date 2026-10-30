import pino from 'pino';
import { redactDeep, redactText } from './redaction.js';

export interface RedactingLoggerOptions {
  level?: string;
  /** 关闭后原样输出，便于本地排障（对应 DATA_REDACTION_ENABLED=false） */
  redact?: boolean;
  /** 自定义输出目标，默认 stdout；测试可注入内存流 */
  stream?: pino.DestinationStream;
}

function redactArgument(value: unknown): unknown {
  return typeof value === 'string' ? redactText(value) : redactDeep(value);
}

/** pino 实例：在日志进入传输层前统一脱敏手机号、邮箱、身份证号与密钥 */
export function createRedactingLogger(
  options: RedactingLoggerOptions = {},
): pino.Logger {
  const level = options.level ?? 'info';
  const destination = options.stream ?? pino.destination(1);
  if (options.redact === false) return pino({ level }, destination);
  return pino(
    {
      level,
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map(redactArgument) as never);
        },
      },
    } as pino.LoggerOptions,
    destination,
  );
}
