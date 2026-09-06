import type { EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/** Scenario-scoped checks, not a general capitalization rule or output filter. */
export function checkChatVoice(t: EveEvalContext, reply: string | undefined): void {
  t.check(reply, satisfies<string | undefined>(
    text => typeof text === "string" && !/\b(?:I(?:['’]\w+)?|[A-Z][a-z]+)\b/.test(
      text.replace(/\b(?:Eve|San Francisco|Anthropic|Claude|NoScroll)\b/g, ""),
    ),
    "lowercase chat prose, allowing proper names and acronyms",
  ));
  t.check(reply, satisfies<string | undefined>(
    text => typeof text === "string" && !/let me know if|(?:anything|something) (?:i can|you need) help with|(?:i['’]m|i['’]ll be) (?:here|around) (?:if|whenever)/i.test(text),
    "no generic assistant offers",
  ));
}
