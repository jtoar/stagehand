import { AvailableModel, LLMProvider } from "../llm/LLMProvider";
import { LogLine } from "../types";
import { Stagehand } from "../index";
import { observe } from "../inference";
import { modelsWithVision } from "../llm/LLMClient";
import { ScreenshotService } from "../vision";
import { generateId } from "../utils";

export class StagehandObserveHandler {
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
  private observations: {
    [key: string]: {
      result: { selector: string; description: string }[];
      instruction: string;
    };
  };

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
    logger: (logLine: LogLine) => void;
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
    this.verbose = verbose;
    this.observations = {};
  }

  private async _recordObservation(
    instruction: string,
    result: { selector: string; description: string }[],
  ): Promise<string> {
    const id = generateId(instruction);

    this.observations[id] = { result, instruction };

    return id;
  }

  public async observe({
    instruction,
    useVision,
    fullPage,
    modelName,
    requestId,
    domSettleTimeoutMs,
  }: {
    instruction: string;
    useVision: boolean;
    fullPage: boolean;
    modelName?: AvailableModel;
    requestId?: string;
    domSettleTimeoutMs?: number;
  }): Promise<{ selector: string; description: string }[]> {
    if (!instruction) {
      instruction = `Find elements that can be used for any future actions in the page. These may be navigation links, related pages, section/subsection links, buttons, or other interactive elements. Be comprehensive: if there are multiple elements that may be relevant for future actions, return all of them.`;
    }

    const model = modelName ?? this.defaultModelName;

    this.logger({
      category: "observation",
      message: "starting observation",
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
    let { outputString, selectorMap } = await this.stagehand.page.evaluate(
      (fullPage: boolean) =>
        fullPage ? window.processAllOfDom() : window.processDom([]),
      fullPage,
    );

    let annotatedScreenshot: Buffer | undefined;
    if (useVision === true) {
      if (!modelsWithVision.includes(model)) {
        this.logger({
          category: "observation",
          message: "Model does not support vision. Skipping vision processing.",
          level: 1,
          auxiliary: {
            model: {
              value: model,
              type: "string",
            },
          },
        });
      } else {
        const screenshotService = new ScreenshotService(
          this.stagehand.page,
          selectorMap,
          this.verbose,
          this.logger,
        );

        annotatedScreenshot =
          await screenshotService.getAnnotatedScreenshot(fullPage);
        outputString = "n/a. use the image to find the elements.";
      }
    }

    const observationResponse = await observe({
      instruction,
      domElements: outputString,
      llmProvider: this.llmProvider,
      modelName: modelName || this.defaultModelName,
      image: annotatedScreenshot,
      requestId,
    });

    const elementsWithSelectors = observationResponse.elements.map(
      (element) => {
        const { elementId, ...rest } = element;

        return {
          ...rest,
          selector: `xpath=${selectorMap[elementId][0]}`,
        };
      },
    );

    await this.cleanupDomDebug();

    this.logger({
      category: "observation",
      message: "found elements",
      level: 1,
      auxiliary: {
        elements: {
          value: JSON.stringify(elementsWithSelectors),
          type: "object",
        },
      },
    });

    await this._recordObservation(instruction, elementsWithSelectors);
    return elementsWithSelectors;
  }
}
