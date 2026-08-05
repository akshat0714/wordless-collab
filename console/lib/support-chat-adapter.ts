import {
  parseSupportChatResponse,
  type SupportChatRequest,
  type SupportChatResponse,
} from "./support-chat-schema.ts";
import {
  resolveKnownSupportMessage,
  unresolvedSupportMessage,
} from "./support-normal-resolver.ts";
import type { UpstreamChatAssistResponse } from "./support-chat-upstream.ts";

export function createHostSupportChatResponse(input: SupportChatRequest): SupportChatResponse {
  const resolved = resolveKnownSupportMessage(input.message) ?? unresolvedSupportMessage();
  return parseSupportChatResponse({
    schema_version: 1,
    request_id: input.request_id,
    reply_id: `reply_${input.request_id.replaceAll("-", "")}`,
    kind: resolved.kind,
    response_source: "host_bot",
    message: resolved.message,
    choices: [],
    review_required: false,
    suggestion_id: null,
  });
}

function wordlessReply(
  input: SupportChatRequest,
  assist: UpstreamChatAssistResponse,
  choices: SupportChatResponse["choices"],
): SupportChatResponse {
  if (assist.message === null) {
    throw new Error("A visible Wordless turn requires a message");
  }
  return parseSupportChatResponse({
    schema_version: 1,
    request_id: input.request_id,
    reply_id: `reply_${assist.suggestion_id.slice(3)}`,
    kind: assist.outcome,
    response_source: "wordless",
    message: assist.message,
    choices,
    review_required: assist.review_required,
    suggestion_id: assist.suggestion_id,
  });
}

/** Map the backend directive before considering the outcome-specific display payload. */
export function adaptSupportChatResponse(
  input: SupportChatRequest,
  assist: UpstreamChatAssistResponse,
): SupportChatResponse {
  if (
    assist.integration.host_action === "continue_host_bot" &&
    assist.integration.render_mode === "none"
  ) {
    return createHostSupportChatResponse(input);
  }

  if (
    assist.integration.host_action === "show_wordless" &&
    assist.integration.render_mode === "choices"
  ) {
    return wordlessReply(
      input,
      assist,
      assist.choices.map((choice) => ({
        id: choice.id,
        detector_id: choice.detector_id,
        label: choice.detector_id === null && assist.outcome === "clarification_choices"
          ? "None of these"
          : choice.label,
        detail: choice.reply,
        evidence_label:
          choice.detector_id === null
            ? null
            : `${choice.evidence.length} synthetic account ${choice.evidence.length === 1 ? "record supports" : "records support"} this choice`,
      })),
    );
  }

  if (
    assist.integration.host_action === "show_wordless" &&
    assist.integration.render_mode === "message"
  ) {
    return wordlessReply(input, assist, []);
  }

  throw new Error("The chat assist integration directive is unsupported");
}
