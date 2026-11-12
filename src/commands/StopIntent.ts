/**
 * 自然语言「停止 / 暂停 / 关闭当前任务」意图识别。
 *
 * 只在整句本身就是一条停止指令时命中，避免把「如何停止一个进程」「帮我写个关闭按钮」
 * 这类正常需求误判成控制指令。仅用于 @ 机器人 / 单聊路径（CommandRouter.tryHandle），
 * 不改动 parseCommand，因此群里非 @ 的闲聊「暂停」不会误触发停任务。
 */

/** 与 MessageParser.stripLeadingMentions 一致：去掉行首 @提及 */
const LEADING_MENTION = /^(?:\s*@[^\s@]+\s*)+/u;

/** 句首礼貌 / 催促填充词，可重复出现 */
const LEADING_FILLER =
  /^(?:请问|请|麻烦你|麻烦|帮我|帮忙|给我|你们|你|机器人|小钉|小助手|老师|现在|立刻|马上|赶紧|快点|快|先|再)+/u;

/** 句尾语气词，可重复出现 */
const TRAILING_PARTICLE = /(?:一下|下|吧|了|啊|呀|哦|噢|喔|呗|呢|哈|嘛)+$/u;

/** 首尾标点与引号 */
const SURROUNDING_PUNCT =
  /^[\s。．.!！?？，,、;；:：~～·「」『』“”‘’"'()（）【】\[\]]+|[\s。．.!！?？，,、;；:：~～·「」『』“”‘’"'()（）【】\[\]]+$/gu;

const STOP_VERB = '(?:停止|暂停|关闭|终止|中止|停下来|停下|停掉|关掉|停手|打住|关|停)';
const DETERMINER = '(?:当前|这个|该|正在跑的|正在执行的|正在运行的)?';
const STOP_OBJECT = '(?:任务|回答|执行|运行|操作|工作|播报|查询|搜索|进程|线程)';
const NEGATIVE_VERB = '(?:跑了|跑|做了|做|查了|查|搜了|搜|回答了|回答|执行了|执行|继续了|继续|弄了|弄|搞了|搞)';

/** 整句匹配：bare 动词 / 动词+对象 / 否定祈使 / 取消+对象 / 把字句 */
const STOP_PATTERNS: readonly RegExp[] = [
  new RegExp(`^${STOP_VERB}$`, 'u'),
  new RegExp(`^${STOP_VERB}${DETERMINER}${STOP_OBJECT}$`, 'u'),
  new RegExp(`^(?:别|不要|不用|不)${NEGATIVE_VERB}$`, 'u'),
  new RegExp(`^取消${DETERMINER}(?:任务|执行|运行|回答|操作)$`, 'u'),
  new RegExp(`^把${DETERMINER}(?:任务|回答|执行|运行|它|他)?${STOP_VERB}$`, 'u'),
];

const ENGLISH_STOP = /^(?:stop|pause|cancel|abort|quit|halt)$/iu;

function clean(text: string): string {
  let s = text.replace(LEADING_MENTION, '').trim();
  // 中文不依赖空格分词，去掉全部空白让「停 止」「停止 任务」也能命中
  s = s.replace(/\s+/gu, '');
  for (let i = 0; i < 3; i += 1) {
    const next = s
      .replace(SURROUNDING_PUNCT, '')
      .replace(LEADING_FILLER, '')
      .replace(TRAILING_PARTICLE, '')
      .replace(SURROUNDING_PUNCT, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 整句是否就是一条「立即停止当前任务」的指令 */
export function detectStopIntent(text: string): boolean {
  const s = clean(text);
  if (!s) return false;
  if (ENGLISH_STOP.test(s)) return true;
  return STOP_PATTERNS.some((pattern) => pattern.test(s));
}