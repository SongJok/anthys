import 'dotenv/config';
import pino from 'pino';
import { DWClient } from 'dingtalk-stream';
import { EnvConfigProvider } from './config/EnvConfigProvider.js';
import { createDatabase } from './db/client.js';
import { seedAgentConfigs, loadLLMOverrides, applyLLMOverrides } from './db/seed.js';
import {
  CardStreamer,
  OpenApiCardApi,
  type CardLogger,
} from './dingtalk/CardStreamer.js';
import { StreamGateway, type StreamGatewayLogger } from './dingtalk/StreamGateway.js';
import { AgentHarness, type HarnessLogger } from './harness/AgentHarness.js';
import { ContextAssembler } from './memory/ContextAssembler.js';
import { DrizzleConversationRepository } from './memory/ConversationRepository.js';
import { BuiltinToolProvider } from './react/BuiltinTools.js';
import { createChatModel } from './react/createChatModel.js';
import { ReActRunner } from './react/ReActRunner.js';
import type { InboundMessage } from './types/core.js';

const FALLBACK_ERROR_TEXT = '抱歉，处理这条消息时出现异常，请稍后重试。';

async function sendSessionWebhook(
  message: InboundMessage,
  text: string,
  logger: CardLogger,
): Promise<void> {
  const webhook = message.rawPayload.sessionWebhook;
  if (typeof webhook !== 'string' || !webhook) {
    logger.warn(
      { messageId: message.messageId },
      'no sessionWebhook available for text fallback',
    );
    return;
  }
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: '智能助手', text },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      logger.warn(
        { messageId: message.messageId, status: response.status },
        'sessionWebhook fallback failed',
      );
    }
  } catch (error) {
    logger.warn(
      {
        messageId: message.messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      'sessionWebhook fallback failed',
    );
  }
}

async function main(): Promise<void> {
  const config = new EnvConfigProvider();
  try {
    config.assertReady();
  } catch (error) {
    console.error(
      `配置校验失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const harnessLogger: HarnessLogger = {
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  };
  const gatewayLogger: StreamGatewayLogger = harnessLogger;
  const cardLogger: CardLogger = harnessLogger;

  const dbHandle = createDatabase(config.getDatabaseUrl());

  try {
    const baseLLM = config.getLLMConfig();
    await seedAgentConfigs(dbHandle.db, baseLLM);
    const llm = applyLLMOverrides(
      baseLLM,
      await loadLLMOverrides(dbHandle.db),
    );
    const policy = config.getLoopPolicy();
    const memory = config.getMemoryConfig();
    const dingtalk = config.getDingTalkConfig();

    const engine = new ReActRunner({
      model: createChatModel(llm),
      toolProviders: [new BuiltinToolProvider()],
      policy,
      temperature: llm.temperature,
      enableNativeReasoning: llm.enableNativeReasoning,
    });
    const harness = new AgentHarness({
      engine,
      repository: new DrizzleConversationRepository(dbHandle.db),
      assembler: new ContextAssembler({ windowMessages: memory.windowMessages }),
      persona: llm.persona,
      policy,
      windowMessages: memory.windowMessages,
      logger: harnessLogger,
    });

    const client = new DWClient({
      clientId: dingtalk.clientId,
      clientSecret: dingtalk.clientSecret,
      keepAlive: true,
    });
    let cachedToken: { value: string; expiresAt: number } | null = null;
    const getAccessToken = async (): Promise<string> => {
      if (cachedToken && cachedToken.expiresAt > Date.now()) {
        return cachedToken.value;
      }
      const value = String(await client.getAccessToken());
      cachedToken = { value, expiresAt: Date.now() + 30 * 60_000 };
      return value;
    };

    const cardApi = new OpenApiCardApi({
      clientId: dingtalk.clientId,
      clientSecret: dingtalk.clientSecret,
      getAccessToken,
      logger: cardLogger,
    });

    const gateway = new StreamGateway({
      client,
      logger: gatewayLogger,
      handler: async (message) => {
        const streamer = new CardStreamer({
          api: cardApi,
          message,
          cardTemplateId: dingtalk.cardTemplateId,
          robotCode: dingtalk.robotCode,
          logger: cardLogger,
        });
        await streamer.start();
        try {
          const result = await harness.handleMessage(message, {
            emit: (event) => streamer.handle(event),
          });
          await streamer.finish();
          if (result && !streamer.isAvailable && result.answer) {
            await sendSessionWebhook(message, result.answer, cardLogger);
          }
        } catch (error) {
          logger.error(
            {
              messageId: message.messageId,
              error: error instanceof Error ? error.stack ?? error.message : String(error),
            },
            'turn failed',
          );
          streamer.handle({ type: 'error', message: FALLBACK_ERROR_TEXT });
          await streamer.finish();
          if (!streamer.isAvailable) {
            await sendSessionWebhook(message, FALLBACK_ERROR_TEXT, cardLogger);
          }
        }
      },
    });

    await gateway.start();
    logger.info(
      {
        model: llm.model,
        provider: llm.provider,
        persona: llm.persona.name,
        nativeReasoning: llm.enableNativeReasoning,
        maxWallTimeMs: policy.maxWallTimeMs,
        maxTotalTokens: policy.maxTotalTokens,
      },
      'dingtalk agent is ready',
    );

    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      logger.info({ signal }, 'shutting down');
      gateway.stop();
      await dbHandle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      'startup failed',
    );
    await dbHandle.close();
    process.exitCode = 1;
  }
}

void main();
