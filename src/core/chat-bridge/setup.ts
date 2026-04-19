import {
  getChatBridgeAdapterSpec,
  listChatBridgeAdapterPromptOptions,
} from "./adapters.js";
import type {
  ChatBridgeBuiltInAdapterKey,
  ChatBridgePromptFieldSpec,
  ChatBridgePromptFieldValue,
  ChatBridgePromptFieldValues,
} from "./adapters.js";

export type ChatBridgePromptApi = {
  ensureNotCancelled: <T>(value: T | symbol | undefined | null) => T;
  select: (options: any) => Promise<any>;
  text: (options: any) => Promise<any>;
  confirm: (options: any) => Promise<any>;
};

export type ChatBridgeSetupResult = {
  adapterKey: string;
  chatDescription: string;
  chatDetail: string;
  chatConfig: any;
};

async function promptText(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    required?: boolean;
    validate?: (value: string) => string | void;
  },
) {
  return String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: options.message,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
        validate(value: string) {
          const next = String(value || "").trim();
          if (options.required && !next) return "This field is required.";
          return options.validate?.(next);
        },
      }),
    ),
  ).trim();
}

async function promptSelectValue<T extends string>(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    values: Array<{ value: T; label: string; hint?: string }>;
  },
) {
  return String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: options.message,
        options: options.values,
      }),
    ),
  ) as T;
}

async function promptFieldValue(
  prompt: ChatBridgePromptApi,
  field: ChatBridgePromptFieldSpec,
): Promise<ChatBridgePromptFieldValue> {
  if (field.kind === "select") {
    return await promptSelectValue(prompt, {
      message: field.message,
      values: field.values,
    });
  }

  const value = await promptText(prompt, {
    message: field.message,
    placeholder: field.placeholder,
    defaultValue: field.defaultValue,
    required: field.required,
    validate(value) {
      if (field.kind === "url") {
        if (!value && !field.required) return;
        try {
          new URL(value);
        } catch {
          return "Use a valid URL.";
        }
      }
      return field.validate?.(value);
    },
  });
  return value || undefined;
}

async function promptFieldValues(
  prompt: ChatBridgePromptApi,
  fields: readonly ChatBridgePromptFieldSpec[],
) {
  const values: ChatBridgePromptFieldValues = {};
  for (const field of fields) {
    values[field.key] = await promptFieldValue(prompt, field);
  }
  return values;
}

async function promptChatBridgeAdapterConfig(
  prompt: ChatBridgePromptApi,
  adapterKey: ChatBridgeBuiltInAdapterKey,
) {
  const adapterSpec = getChatBridgeAdapterSpec(adapterKey);
  const promptDefinition = adapterSpec?.installer.prompt;
  if (!adapterSpec || !promptDefinition) {
    throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);
  }

  const values = await promptFieldValues(prompt, promptDefinition.fields);
  return {
    detail: promptDefinition.detail(values),
    config: promptDefinition.config(values),
  };
}

export async function promptChatBridgeSetup(
  prompt: ChatBridgePromptApi,
  options: { confirmEnable?: boolean } = {},
) {
  const shouldConfirmEnable = options.confirmEnable !== false;
  const enableChatBridge = shouldConfirmEnable
    ? prompt.ensureNotCancelled(
        await prompt.confirm({
          message: "Configure a chat bridge now?",
          initialValue: false,
        }),
      )
    : true;

  let chatDescription = "disabled for now";
  let chatDetail = "";
  let chatConfig: any = null;
  let adapterKey = "";
  if (!enableChatBridge) {
    return { adapterKey, chatDescription, chatDetail, chatConfig };
  }

  adapterKey = await promptSelectValue(prompt, {
    message: "Choose a chat platform.",
    values: listChatBridgeAdapterPromptOptions(),
  });
  const adapterSpec = getChatBridgeAdapterSpec(adapterKey);
  if (!adapterSpec)
    throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);

  chatDescription = adapterSpec.label;
  const configured = await promptChatBridgeAdapterConfig(
    prompt,
    adapterSpec.key,
  );
  chatDetail = configured.detail;
  chatConfig = configured.config;

  return {
    adapterKey,
    chatDescription,
    chatDetail,
    chatConfig,
  } as ChatBridgeSetupResult;
}
