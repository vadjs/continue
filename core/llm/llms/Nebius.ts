import {
  ChatMessage,
  CompletionOptions,
  LLMOptions,
  ModelProvider,
} from "../../index.js";
import { stripImages } from "../images.js";
import { BaseLLM } from "../index.js";
import { streamSse } from "../stream.js";

// There are no "Non-chat" models yet. But it's planned to be added later.
const NON_CHAT_MODELS: string[] = [];

const CHAT_ONLY_MODELS: string[] = [
  "meta-llama/Meta-Llama-3.1-70B-Instruct",
  "meta-llama/Meta-Llama-3.1-405B-Instruct",
  "Qwen/Qwen2.5-Coder-7B",
  "Qwen/Qwen2.5-Coder-7B-Instruct",
  "deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct",
];

class Nebius extends BaseLLM {
  public useLegacyCompletionsEndpoint: boolean | undefined = undefined;

  maxStopWords: number | undefined = undefined;

  constructor(options: LLMOptions) {
    super(options);
    this.useLegacyCompletionsEndpoint = options.useLegacyCompletionsEndpoint;
    this.apiVersion = options.apiVersion ?? "2023-07-01-preview";
  }

  static providerName: ModelProvider = "nebius";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.studio.nebius.ai/v1/",
  };

  protected _convertMessage(message: ChatMessage) {
    if (typeof message.content === "string") {
      return message;
    } else if (!message.content.some((item) => item.type !== "text")) {
      // If no multi-media is in the message, just send as text
      // for compatibility with "compatible" servers
      // that don't support multi-media format
      return {
        ...message,
        content: message.content.map((item) => item.text).join(""),
      };
    }

    const parts = message.content.map((part) => {
      const msg: any = {
        type: part.type,
        text: part.text,
      };
      if (part.type === "imageUrl") {
        msg.image_url = { ...part.imageUrl, detail: "low" };
        msg.type = "image_url";
      }
      return msg;
    });
    return {
      ...message,
      content: parts,
    };
  }

  protected _convertArgs(
    options: Record<string, any>,
    messages: ChatMessage[],
  ): Record<string, any> {
    const finalOptions: Record<string, any> = {
      messages: messages.map(this._convertMessage),
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      stream: options.stream ?? true,
      stop:
        this.maxStopWords !== undefined
          ? options.stop?.slice(0, this.maxStopWords)
          : options.stop,
    };

    return finalOptions;
  }

  protected _getHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  protected async _complete(
    prompt: string,
    options: CompletionOptions,
  ): Promise<string> {
    let completion = "";
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      options,
    )) {
      completion += chunk.content;
    }

    return completion;
  }

  protected _getEndpoint(
    endpoint: "chat/completions" | "completions" | "models",
  ) {
    if (!this.apiBase) {
      throw new Error(
        "No API base URL provided. Please set the 'apiBase' option in config.json",
      );
    }

    if (endpoint === "completions") {
      // Nebius doesn't support completions enpoint yet.
      // Use chat/completions instead.
      return new URL("chat/completions", this.apiBase);
    }

    return new URL(endpoint, this.apiBase);
  }

  protected async *_streamComplete(
    prompt: string,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      options,
    )) {
      yield stripImages(chunk.content);
    }
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    const body = this._convertArgs(options, messages);
    const response = await this.fetch(this._getEndpoint("chat/completions"), {
      method: "POST",
      headers: this._getHeaders(),
      body: JSON.stringify(body),
    });

    // Handle non-streaming response
    if (body.stream === false) {
      const data = await response.json();
      yield data.choices[0].message;
      return;
    }

    for await (const value of streamSse(response)) {
      if (value.choices?.[0]?.delta?.content) {
        yield value.choices[0].delta;
      }
    }
  }

  async listModels(): Promise<string[]> {
    return [...NON_CHAT_MODELS, ...CHAT_ONLY_MODELS];
  }
}

export default Nebius;
