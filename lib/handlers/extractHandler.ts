import { AvailableModel, LLMProvider } from "../llm/LLMProvider";
import { Stagehand } from "../index";
import { z } from "zod";
import { LogLine } from "../types";
import { extract } from "../inference";

export class StagehandExtractHandler {
  private readonly stagehand: Stagehand;

  private readonly logger: (logLine: LogLine) => void;
  private readonly waitForSettledDom: (
    domSettleTimeoutMs?: number,
  ) => Promise<void>;
  private readonly startDomDebug: () => Promise<void>;
  private readonly cleanupDomDebug: () => Promise<void>;
  private readonly defaultModelName: AvailableModel;
  private readonly llmProvider: LLMProvider;
  private readonly verbose: 0 | 1 | 2;

  constructor({
    stagehand,
    logger,
    waitForSettledDom,
    defaultModelName,
    startDomDebug,
    cleanupDomDebug,
    llmProvider,
    verbose,
  }: {
    stagehand: Stagehand;
    logger: (message: {
      category?: string;
      message: string;
      level?: number;
      auxiliary?: { [key: string]: { value: string; type: string } };
    }) => void;
    waitForSettledDom: (domSettleTimeoutMs?: number) => Promise<void>;
    defaultModelName: AvailableModel;
    startDomDebug: () => Promise<void>;
    cleanupDomDebug: () => Promise<void>;
    llmProvider: LLMProvider;
    verbose: 0 | 1 | 2;
  }) {
    this.stagehand = stagehand;
    this.logger = logger;
    this.waitForSettledDom = waitForSettledDom;
    this.defaultModelName = defaultModelName;
    this.startDomDebug = startDomDebug;
    this.cleanupDomDebug = cleanupDomDebug;
    this.llmProvider = llmProvider;
  }

  public async extract<T extends z.AnyZodObject>({
    instruction,
    schema,
    progress = "",
    content = {},
    chunksSeen = [],
    modelName,
    requestId,
    domSettleTimeoutMs,
  }: {
    instruction: string;
    schema: T;
    progress?: string;
    content?: z.infer<T>;
    chunksSeen?: Array<number>;
    modelName?: AvailableModel;
    requestId?: string;
    domSettleTimeoutMs?: number;
  }): Promise<z.infer<T>> {
    this.logger({
      category: "extraction",
      message: "starting extraction",
      level: 1,
      auxiliary: {
        instruction: {
          value: instruction,
          type: "string",
        },
      },
    });

    await this.waitForSettledDom(domSettleTimeoutMs);
    await this.startDomDebug();
    const { outputString, chunk, chunks } = await this.stagehand.page.evaluate(
      (chunksSeen?: number[]) => window.processDom(chunksSeen ?? []),
      chunksSeen,
    );

    this.logger({
      category: "extraction",
      message: "received output from processDom.",
      auxiliary: {
        chunk: {
          value: chunk.toString(),
          type: "integer",
        },
        chunks_left: {
          value: (chunks.length - chunksSeen.length).toString(),
          type: "integer",
        },
        chunks_total: {
          value: chunks.length.toString(),
          type: "integer",
        },
      },
    });

    const extractionResponse = await extract({
      instruction,
      progress,
      previouslyExtractedContent: content,
      domElements: outputString,
      llmProvider: this.llmProvider,
      schema,
      modelName: modelName || this.defaultModelName,
      chunksSeen: chunksSeen.length,
      chunksTotal: chunks.length,
      requestId,
    });

    const {
      metadata: { progress: newProgress, completed },
      ...output
    } = extractionResponse;
    await this.cleanupDomDebug();

    this.logger({
      category: "extraction",
      message: "received extraction response",
      auxiliary: {
        extraction_response: {
          value: JSON.stringify(extractionResponse),
          type: "object",
        },
      },
    });

    chunksSeen.push(chunk);

    if (completed || chunksSeen.length === chunks.length) {
      this.logger({
        category: "extraction",
        message: "got response",
        auxiliary: {
          extraction_response: {
            value: JSON.stringify(extractionResponse),
            type: "object",
          },
        },
      });

      return output;
    } else {
      this.logger({
        category: "extraction",
        message: "continuing extraction",
        auxiliary: {
          extraction_response: {
            value: JSON.stringify(extractionResponse),
            type: "object",
          },
        },
      });
      await this.waitForSettledDom(domSettleTimeoutMs);
      return this.extract({
        instruction,
        schema,
        progress: newProgress,
        content: output,
        chunksSeen,
        modelName,
        domSettleTimeoutMs,
      });
    }
  }
}
