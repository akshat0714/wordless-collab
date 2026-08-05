const humanRoleSource = String.raw`(?:(?:actual\s+)?human(?:\s+(?:agent|representative|being|assistance))?|real\s+person|live\s+(?:person|agent|representative|operator)|support\s+(?:person|agent|representative|manager)|customer\s+(?:care|service|support)(?:\s+(?:agent|representative|manager|operator|team))?|service\s+rep|team\s+member|member\s+of\s+(?:(?:the|your)\s+)?(?:staff|team)|staff(?:\s+member)?|advisor|associate|employee|specialist|agent|representative|operator|supervisor|manager|someone(?:\s+else)?|somebody(?:\s+else)?|person)`;
const humanActionTargetSource = String.raw`(?:${humanRoleSource}|support(?:\s+team)?)`;
const humanRoleWithArticleSource = String.raw`(?:(?:an?|the|your)\s+)?${humanRoleSource}`;
const humanActionTargetWithArticleSource = String.raw`(?:(?:an?|the|your)\s+)?${humanActionTargetSource}`;
const humanRoleSuffixSource = String.raw`(?=$|\s+(?:please|now|anyway|asap|urgently|to|for|from|on|about|regarding|with|because|help)\b|\s+who\s+(?:can|will)\s+help\b)`;
const humanOnlyPattern = new RegExp(
  String.raw`^(?:please\s+)?${humanRoleWithArticleSource}(?:\s+please)?$`,
  "iu",
);
const humanActionPattern = new RegExp(
  String.raw`(?:^|\b(?:(?:please\s+)|(?:can|could|would|will|may)\s+(?:i|you)\s+|(?:i\s+)?(?:want|need|prefer)\s+to\s+|i\s+would\s+like\s+to\s+|i['’]d\s+like\s+to\s+))(?:please\s+)?(?:(?:talk|speak|chat)\s+(?:to|with)|let\s+me\s+(?:talk|speak|chat)\s+(?:to|with)|(?:connect|transfer)(?:\s+me)?\s+(?:to|with)|(?:be|get)\s+(?:connected|transferred)\s+(?:to|with)|put\s+me\s+through\s+to|(?:reach|contact)|escalate(?:\s+(?:me|this|the\s+(?:chat|conversation|case|issue)))?(?:\s+to)?|hand(?:\s+(?:me|this|the\s+(?:chat|conversation|case|issue)))?\s+off(?:\s+to)?|get\s+me)\s+${humanActionTargetWithArticleSource}${humanRoleSuffixSource}`,
  "iu",
);
const humanWantPattern = new RegExp(
  String.raw`\b(?:(?:i\s+)?(?:really\s+)?(?:need|want|prefer)|i\s+would\s+(?:like|prefer)|i['’]d\s+(?:like|prefer)|(?:can|could|may)\s+i\s+(?:get|have))\s+(?:to\s+)?${humanRoleWithArticleSource}${humanRoleSuffixSource}`,
  "iu",
);
const humanQueryPattern = new RegExp(
  String.raw`^(?:please\s+)?(?:is\s+there|do\s+you\s+have|can\s+i\s+(?:get|have))\s+${humanRoleWithArticleSource}(?:\s+(?:i|we)\s+can\s+(?:talk|speak|chat)\s+(?:to|with))?${humanRoleSuffixSource}`,
  "iu",
);
const humanPreferencePattern = new RegExp(
  String.raw`^(?:please\s+)?${humanRoleWithArticleSource}\s+(?:would|might)\s+be\s+(?:better|best|helpful|easier)$`,
  "iu",
);
const humanRolelessObjectSource = String.raw`(?:me|this|(?:this|the)\s+(?:chat|conversation|case|issue))`;
const humanRolelessActionSource = String.raw`(?:(?:connect|forward|route|transfer)\s+${humanRolelessObjectSource}|put\s+${humanRolelessObjectSource}\s+through|hand\s+${humanRolelessObjectSource}\s+off|escalate(?:\s+${humanRolelessObjectSource})?)`;
const humanRolelessHandoffPattern = new RegExp(
  String.raw`^(?:please\s+)?(?:${humanRolelessActionSource}|(?:can|could|may|would|will)\s+(?:i\s+(?:(?:get|be)\s+(?:connected|transferred)|be\s+put\s+through)|(?:you\s+)?(?:please\s+)?${humanRolelessActionSource})|i\s+(?:need|want|would\s+like)\s+(?:(?:(?:you\s+)?to\s+)?${humanRolelessActionSource}|to\s+be\s+(?:connected|transferred))|i\s+(?:need|want|would\s+like)\s+(?:this|the\s+(?:chat|conversation|case|issue))\s+escalated)(?:\s+(?:please|now|right\s+now|asap|anyway))?$`,
  "iu",
);
const humanDirectRoutePattern = new RegExp(
  String.raw`^(?:please\s+)?(?:forward|pass|route)\s+me\s+(?:to|with)\s+${humanActionTargetWithArticleSource}${humanRoleSuffixSource}`,
  "iu",
);
const humanColloquialHandoffPattern = new RegExp(
  String.raw`^(?:please\s+)?(?:(?:bring|loop)\s+in\s+${humanActionTargetWithArticleSource}|get\s+${humanRoleWithArticleSource}\s+involved|(?:can|could|may|would|will)\s+(?:i|you)\s+(?:please\s+)?(?:pass\s+me\s+on|bring\s+in\s+${humanActionTargetWithArticleSource})|i\s+(?:need|want|would\s+like)\s+to\s+be\s+put\s+through)(?:\s+(?:please|now|asap))?$`,
  "iu",
);
const humanPassiveHandoffPattern = /^(?:(?:can|could|may|would|will)\s+(?:this|(?:this|the)\s+(?:chat|conversation|case|issue))\s+be\s+(?:escalated|transferred|handed\s+off)|i\s+(?:need|want|would\s+like)\s+(?:this|(?:this|the)\s+(?:chat|conversation|case|issue))\s+(?:escalated|transferred|handed\s+off))$/iu;
const humanRetractionPattern = /^(?:(?:actually\s+)?(?:never\s*mind(?:\s+(?:that|actually))?|cancel\s+(?:that|it)|do\s+not|don['’]?t)|(?:please\s+)?(?:cancel(?:\s+(?:it|that))?|do\s+not|don['’]?t)|actually\s+no(?:\s+thanks)?|(?:i(?:['’]?ve|\s+have)?\s+)?changed\s+my\s+mind(?:\s+about\s+(?:that|it))?|(?:i\s+)?take\s+that\s+back|scratch\s+that|forget\s+(?:it|that)|cancel\s+(?:(?:the|my)\s+)?request|not\s+anymore|no\s+thank\s+you|no\s+thanks|stop|(?:i['’]?d|i\s+would)?\s*rather\s+not|(?:i\s+)?(?:do\s+not\s+consent|don['’]?t\s+consent|decline(?:\s+the\s+handoff)?|opt\s+out)|(?:actually\s+)?(?:do\s+not|don['’]?t|never)\s+(?:connect|escalate|forward|hand|pass|route|transfer)(?:\s+me)?(?:\s+(?:to|with))?|wait\s+no|on\s+second\s+thought\s+no|(?:i['’]?d|i\s+would)\s+rather\s+(?:stay|continue)\s+with\s+(?:the\s+)?(?:bot|chatbot|robot)|(?:i\s+)?(?:remain|stay)\s+with\s+(?:the\s+)?(?:bot|chatbot|robot)|(?:please\s+)?keep\s+(?:(?:talking\s+to\s+)|(?:me\s+(?:with|on)\s+)|(?:me\s+using\s+))?(?:the\s+)?(?:bot|chatbot|robot)|(?:no\s+)?(?:actually\s+)?keep\s+(?:(?:me\s+(?:with|on)\s+)|(?:me\s+using\s+))?(?:the\s+)?(?:bot|chatbot|robot))$/iu;
const humanInabilityPattern = new RegExp(
  String.raw`^(?:why\s+)?(?:(?:(?:can(?:not|['’]?t)|could(?:not|n['’]?t))\s+i)|(?:i\s+(?:can(?:not|['’]?t)|could(?:not|n['’]?t))))\s+(?:(?:talk|speak|chat)\s+(?:to|with)|(?:get\s+through|connect|reach|contact)(?:\s+(?:me\s+)?(?:to|with))?)\s+${humanActionTargetWithArticleSource}${humanRoleSuffixSource}`,
  "iu",
);
const negatedHumanRequestPattern = /\b(?:(?:do\s+not|don['’]?t|never)\s+(?:want|need|prefer|talk|speak|chat|connect|transfer|escalate|reach|contact|put|hand|get|have|be)|(?:(?:do|would|can|could|will)\s+not|wouldn['’]?t|can['’]?t|couldn['’]?t|won['’]?t)\s+(?:want|need|prefer|talk|speak|chat|connect|transfer|escalate|reach|contact|put|hand|get|have|be))\b/iu;
const reportedHumanRequestPattern = /\b(?:(?:never|did\s+not|didn['’]?t)\s+(?:say|said|ask|asked)|(?:am|i['’]?m)\s+not\s+(?:asking|requesting))\b/iu;
const historicalHumanRequestPattern = /\b(?:formerly|previously|used\s+to)\s+(?:[a-z]+\s+){0,3}(?:want|need|prefer|ask|asked|request|requested|talk|speak|chat|connect|transfer|escalate|reach|contact|get|have)\b/iu;
const historicalReportedHumanPattern = new RegExp(
  String.raw`^(?:(?:a\s+(?:minute|moment)\s+ago|this\s+morning|two\s+days\s+ago)\s+(?:i\s+)?(?:said|asked|requested|mentioned)\b|i\s+(?:said|told|asked|mentioned)\b[^.!?\n]{0,32}\b(?:yesterday|last\s+(?:week|month|year))\b)[^.!?\n]{0,96}\b${humanRoleSource}\b`,
  "iu",
);
const earlierReportedHumanPattern = new RegExp(
  String.raw`^(?:earlier|before|previously|yesterday|last\s+(?:week|month|year))\b[^.!?\n]{0,48}\b(?:said|asked|requested|told|wrote|mentioned)\b[^.!?\n]{0,48}\b${humanRoleSource}\b`,
  "iu",
);
const metaReportedHumanPattern = new RegExp(
  String.raw`^(?:(?:(?:(?:my|the)\s+)?(?:customer|user|agent|bot|friend)|he|she|they)\b[^.!?\n]{0,48}\b(?:said|says|told|wrote|writes|asked|requested|mentioned)\b|(?:my|the|this)\s+(?:previous\s+)?(?:chat|email|message|text|note|transcript)\s+(?:said|says|reads|contains|mentions)\b|(?:for\s+example[\s,:—–-]+)?say\b|repeat\s+after\s+me\b)[^.!?\n]{0,96}\b${humanRoleSource}\b`,
  "iu",
);
const reportedHumanRequestAcrossBoundaryPattern = new RegExp(
  String.raw`\b(?:never|did\s+not|didn['’]?t)\s+(?:(?:actually|really)\s+)*(?:say|said|sed|sy|ask|asked|tell|told)\b[^.!?\n]{0,96}?\b(?:need|want|prefer|ask|request|talk|speak|chat|connect|transfer|get|have)?\s*(?:an?\s+|the\s+|your\s+)?${humanRoleSource}\b`,
  "iu",
);
const humanMentionQuestionPattern = new RegExp(
  String.raw`^(?:(?:why|when)\s+(?:do|does|did|should|will|would)\s+(?:i|you|we|they|he|she)\s+(?:(?:actually|ever|really|still)\s+)*(?:need|want|prefer)\b[^.!?\n]{0,64}\b${humanRoleSource}\b|how\s+(?:do|does|did|would|will|can|could)\s+(?:i|you|we|they|he|she)\s+[^.!?\n]{0,64}\b(?:if\s+)?(?:need|want|prefer)\b[^.!?\n]{0,48}\b${humanRoleSource}\b|(?:do|does|did|should)\s+(?:i|you|we|they|he|she)\s+(?:(?:actually|ever|really|still)\s+)*(?:(?:need|want|prefer)\b[^.!?\n]{0,64}\b${humanRoleSource}\b|(?:ask|say|tell|request)\b[^.!?\n]{0,48}\b${humanRoleSource}\b)|(?:do|does|did|is|was|would|could)\s+(?:this|that|it|the\s+(?:bot|chatbot|message))\s+(?:mean|say|saying|suggest|imply)\b[^.!?\n]{0,64}\b${humanRoleSource}\b|(?:am|are|is|was|were)\s+(?:i|you|we|they|he|she|the\s+(?:bot|chatbot))\s+(?:asking|saying|requesting)\b[^.!?\n]{0,64}\b${humanRoleSource}\b|who\s+(?:asked|said|says|told)\b[^.!?\n]{0,64}\b${humanRoleSource}\b|what\s+if\s+(?:i|you|we|they|he|she)\s+[^.!?\n]{0,64}\b${humanRoleSource}\b|if\s+(?:i|you|we|they|he|she)\s+(?:(?:actually|ever|really|still)\s+)*(?:need|want|prefer)\b[^.!?\n]{0,64}\b${humanRoleSource}\b[\s,;:—–-]*(?:what|how|would|will|does|do|can)\b|would\s+${humanRoleWithArticleSource}\s+(?:help|be\s+(?:better|helpful))\b)[\s?]*$`,
  "iu",
);
const humanMetaQuestionPattern = new RegExp(
  String.raw`^(?:(?:would|could)\s+(?:i|you|we|they|he|she)\s+(?:need|want|prefer)\b[^.!?\n]{0,64}\b${humanRoleSource}\b|do\s+you\s+think\b[^.!?\n]{0,64}\b${humanRoleSource}\b|(?:do\s+(?:customers?|users?)|why\s+would\s+(?:customers?|users?))\s+(?:need|want|prefer)\b[^.!?\n]{0,64}\b${humanRoleSource}\b|(?:does|is)\s+(?:(?:my|the|this)\s+)?(?:chat|message)\s+(?:mean|saying|suggesting)\b[^.!?\n]{0,64}\b${humanRoleSource}\b|are\s+you\s+(?:suggesting\b|telling\s+me\s+to\s+(?:ask|request)\b)[^.!?\n]{0,64}\b${humanRoleSource}\b)[\s?]*$`,
  "iu",
);
const humanThirdPartyQuestionPattern = new RegExp(
  String.raw`^(?:do|does|did|is|are|should|why\s+(?:do|does|did|would))\b[^.!?\n]{0,48}\b(?:customers?|users?)\b[^.!?\n]{0,64}\b${humanRoleSource}\b[\s?]*$`,
  "iu",
);
const humanConditionalMentionPattern = new RegExp(
  String.raw`^if\s+(?:i|you|we|they|he|she)\s+(?:(?:actually|ever|really|still)\s+)*(?:need|want|prefer)\b[^.!?\n]{0,64}\b${humanRoleSource}\b\s*$`,
  "iu",
);
const humanNonSupportServicePattern = new RegExp(
  String.raw`\b(?:need|want|prefer|get|have)\s+(?:an?\s+|the\s+)?(?:human|person|someone|somebody|agent|representative|staff(?:\s+member)?)\s+to\s+(?:(?:bring|carry|collect|deliver|drive|drop|pick\s+up|ship|sign\s+for)\b|take\s+(?:an?\s+|my\s+|the\s+|this\s+|your\s+)?(?:item|order|package|parcel|return)\b)`,
  "iu",
);
const humanNonSupportContextPattern = new RegExp(
  String.raw`\b${humanRoleWithArticleSource}\s+(?:(?:for\s+(?:(?:a|the|my|home|package|grocery)\s+)*(?:band|delivery|novel|pickup|shipping)(?:\s+tomorrow)?\s*$)|(?:to\s+(?:(?:help|assist)(?:\s+(?:me|us))?(?:\s+(?:in|with))?\s+(?:carry|carrying|deliver|move)|fix\s+(?:(?:a|my|the)\s+)?(?:car|vehicle)|send\s+(?:(?:a|my|the|this)\s+)?(?:item|order|package|parcel)|call\s+(?:(?:a|my|the)\s+)?courier)\b)|(?:with\s+(?:an?\s+)?(?:(?:delivery\s+)?van|(?:pickup\s+)?truck|car)\b))`,
  "iu",
);
const humanRefusalContextPattern = new RegExp(
  String.raw`\b(?:because\s+(?:(?:i\s+)?(?:refuse|decline|opt\s+out|do\s+not\s+consent|don['’]?t\s+consent|stay\s+with\s+(?:the\s+)?(?:bot|chatbot|robot))|(?:i['’]?d|i\s+would)\s+rather\s+(?:stay|continue)\s+with\s+(?:the\s+)?(?:bot|chatbot|robot))|nor\s+(?:(?:do\s+)?i\s+)?(?:want|need|prefer|request)\s+(?:one|${humanRoleSource}))\b`,
  "iu",
);
const humanSupportedPurposeTokens = new Set([
  "address", "answer", "approve", "assist", "call", "cancel", "change", "check",
  "clarify", "close", "connect", "contact", "dispute", "exchange", "explain", "fix",
  "email", "guide", "handle", "help", "investigate", "look", "refund", "replace", "reset", "resolve",
  "review", "speak", "talk", "transfer", "unlock", "update", "verify",
]);
const humanUnsupportedPurposeTokens = new Set([
  "bring", "carry", "collect", "deliver", "drive", "drop", "install", "pick", "receive", "ship",
]);
const humanCurrentReversalPattern = /^(?:(?:but\s+)?i\s+am\s+now|now\s+i\s+am)$/iu;
const humanAnaphoricHandoffPattern = /^(?:please\s+)?(?:(?:connect|forward|pass|route|transfer)(?:\s+me)?\s+(?:to|with)|put\s+me\s+through\s+to)\s+one(?:\s+(?:please|now|asap))?$/iu;
const fuzzyRolelessHandoffPattern = /^(?:please\s+|plese\s+|pls\s+|plz\s+)?(?:(?:conect|connect|forward|route|tranfer|transfer|transfr|trasnfer)\s+me|put\s+me\s+(?:through|thru))(?:\s+(?:asap|now|please|plese|pls|plz))?$/iu;
const humanClauseSeparator = /[.!?;,:—–\n]+|\s+-\s+|\s+\/\s+|\b(?:but|however|instead)\b|\band\s+(?=(?:(?:just\s+)?(?:i|please|plese|pls|plz|can|could|would|will|may|want|wnat|need|prefer|let|connect|conect|transfer|trasnfer|talk|tak|speak|spk|chat|send|give|ask|request)|(?:just\s+)?(?:an?|the)\s+(?:human|person|agent|manager|supervisor))\b)/iu;
const fuzzyHumanRoleTokens = new Set([
  "human", "humans", "hmn", "humna", "humn", "humen", "huamn", "humon", "uman",
  "person", "persons", "peerson", "persn", "prson", "perosn", "persno",
  "advisor", "advisors", "advser", "associate", "associates", "employee", "employees", "specialist", "specialists", "speclist",
  "agent", "agents", "agen", "agnet", "agnt", "agant",
  "representative", "representatives", "represenative", "represntative", "representitive", "rep",
  "operator", "operators", "opertor", "opreator",
  "supervisor", "supervisors", "superviser", "supervsor",
  "manager", "managers", "maneger", "manger", "managr", "mangr", "mgr",
  "someone", "somebody", "somone", "someon", "sombody",
  "staff",
]);
const fuzzyHumanCueTokens = new Set([
  "please", "plese", "pls", "plz",
  "need", "ned", "want", "wnat", "wnt", "prefer",
  "talk", "tak", "tlk", "speak", "spk", "speek", "chat",
  "connect", "conect", "connet", "transfer", "transfr", "trasnfer", "tranfer",
  "escalate", "escelate", "contact", "contct", "reach",
  "get", "let", "put", "send", "give", "have", "call", "help", "hlp", "take",
  "ask", "asking", "request", "requesting",
  "can", "could", "would", "will", "may",
]);
const fuzzyHumanFillers = new Set([
  "a", "actual", "am", "an", "another", "be", "different", "for", "from", "i", "im", "live", "me", "of", "real",
  "support", "the", "this", "through", "to", "with", "you", "your",
]);
const fuzzyHumanPoliteTokens = new Set([
  "anyway", "asap", "now", "please", "plese", "pls", "plz", "urgently",
]);
const fuzzyHumanNegationTokens = new Set([
  "cannot", "cant", "couldnt", "didnt", "dnt", "dont", "never", "no", "not",
  "shouldnt", "wasnt", "werent", "wont", "wouldnt",
]);
const fuzzyHumanReportingTokens = new Set([
  "ask", "asked", "asking", "request", "requested", "requesting", "said", "say", "sed", "sy",
]);

function humanRequestTokens(clause: string): string[] {
  return clause
    .toLowerCase()
    .replace(/['’]/gu, "")
    .split(/[^a-z]+/u)
    .filter((token) => token.length > 0);
}

function purposeIsSupported(tokens: readonly string[], verbIndex: number): boolean {
  const verb = tokens[verbIndex] ?? "";
  const objects = tokens.slice(verbIndex + 1).filter((token) =>
    !["a", "an", "my", "the", "this", "your"].includes(token),
  );
  if (humanSupportedPurposeTokens.has(verb)) return true;
  if (verb === "take") return objects[0] === "over";
  if (verb === "return") return ["call", "email", "message"].includes(objects[0] ?? "");
  if (verb === "open") return ["case", "request", "ticket"].includes(objects[0] ?? "");
  if (["accept", "send"].includes(verb)) {
    return !objects.some((token) => ["delivery", "item", "order", "package", "parcel"].includes(token));
  }
  return !humanUnsupportedPurposeTokens.has(verb);
}

function humanRoleHasUnsupportedPurpose(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  for (let roleIndex = 0; roleIndex < tokens.length - 2; roleIndex += 1) {
    if (!fuzzyHumanRoleTokens.has(tokens[roleIndex]!) || tokens[roleIndex + 1] !== "to") continue;
    if (!purposeIsSupported(tokens, roleIndex + 2)) return true;
  }
  return false;
}

function humanRoleTrailingIsSafe(trailing: readonly string[]): boolean {
  if (trailing.length === 0 || trailing.every((token) => fuzzyHumanPoliteTokens.has(token))) {
    return true;
  }
  let firstMeaningful = 0;
  while (fuzzyHumanPoliteTokens.has(trailing[firstMeaningful] ?? "")) firstMeaningful += 1;
  const core = trailing.slice(firstMeaningful);
  if (core.length === 0) return true;
  if (core.length === 1 && ["me", "us"].includes(core[0]!)) return true;
  if (core.length === 1 && core[0] === "involved") return true;
  if (core[0] === "step" && core[1] === "in") {
    return core.slice(2).every((token) => fuzzyHumanPoliteTokens.has(token));
  }
  if (core[0] === "get" && ["help", "hlp"].includes(core[1] ?? "")) {
    return core.slice(2).every((token) => ["me", "us"].includes(token) || fuzzyHumanPoliteTokens.has(token));
  }
  if (
    core[0] === "to" &&
    ["bring", "carry", "deliver", "drive", "drop", "ship"].includes(core[1] ?? "")
  ) {
    return false;
  }
  if (core[0] === "to") return purposeIsSupported(core, 1);
  if (["about", "because", "for", "from", "on", "regarding", "with"].includes(core[0]!)) {
    return true;
  }
  if (["help", "hlp"].includes(core[0]!) && (core.length === 1 || ["me", "us"].includes(core[1] ?? ""))) {
    return core.slice(core.length === 1 ? 1 : 2).every((token) => fuzzyHumanPoliteTokens.has(token));
  }
  if (["call", "contact"].includes(core[0]!) && ["me", "us"].includes(core[1] ?? "")) {
    return core.slice(2).every((token) => fuzzyHumanPoliteTokens.has(token));
  }
  if (
    core[0] === "who" &&
    ["can", "could", "will", "would"].includes(core[1] ?? "") &&
    core[2] === "help"
  ) {
    return core.slice(3).every((token) =>
      ["me", "us"].includes(token) || fuzzyHumanPoliteTokens.has(token),
    );
  }
  if (
    ["i", "we"].includes(core[0]!) &&
    ["can", "could"].includes(core[1] ?? "") &&
    ["chat", "speak", "talk"].includes(core[2] ?? "") &&
    ["to", "with"].includes(core[3] ?? "")
  ) {
    return core.slice(4).every((token) => fuzzyHumanPoliteTokens.has(token));
  }
  if (
    ["can", "could", "should", "will", "would"].includes(core[0]!) &&
    (
      core[1] === "help" ||
      core[1] === "handle" ||
      ["conect", "connect", "forward", "pass", "route", "send", "tranfer", "transfer"].includes(core[1] ?? "") ||
      (core[1] === "take" && core[2] === "over")
    )
  ) {
    return true;
  }
  if (core[0] === "take" && core[1] === "over") return true;
  if (
    ["need", "ned"].includes(core[0]!) &&
    ["help", "hlp"].includes(core[1] ?? "") &&
    core.slice(2).every((token) => ["me", "us"].includes(token) || fuzzyHumanPoliteTokens.has(token))
  ) {
    return true;
  }
  if (
    ["help", "hlp", "need", "ned", "speak", "spk", "tak", "talk", "tlk", "want", "wnat", "wnt"].includes(core[0]!) &&
    core.slice(1).every((token) => fuzzyHumanPoliteTokens.has(token))
  ) {
    return true;
  }
  if (
    ["ask", "conect", "connect", "forward", "get", "give", "pass", "route", "send", "tranfer", "transfer"].includes(core[0]!) &&
    core.slice(1).every((token) => token === "me" || fuzzyHumanPoliteTokens.has(token))
  ) {
    return true;
  }
  return (
    ["might", "would"].includes(core[0]!) &&
    core[1] === "be" &&
    ["best", "better", "easier", "helpful"].includes(core[2] ?? "") &&
    core.slice(3).every((token) => fuzzyHumanPoliteTokens.has(token))
  );
}

function fuzzyHumanRequestIsNegated(tokens: readonly string[], roleIndex: number): boolean {
  for (let index = 0; index < roleIndex; index += 1) {
    if (!fuzzyHumanNegationTokens.has(tokens[index]!)) continue;
    const scope = tokens.slice(index + 1, roleIndex);
    if (
      scope.length === 0 ||
      scope.some((token) => fuzzyHumanCueTokens.has(token)) ||
      scope.some((token) => fuzzyHumanReportingTokens.has(token))
    ) {
      return true;
    }
  }
  return false;
}

function fuzzyHumanClauseIsNegated(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  return tokens.some((token, roleIndex) =>
    fuzzyHumanRoleTokens.has(token) && fuzzyHumanRequestIsNegated(tokens, roleIndex),
  );
}

function fuzzyHumanRequested(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  if (tokens.length === 0 || tokens.length > 18) return false;
  for (let roleIndex = 0; roleIndex < tokens.length; roleIndex += 1) {
    if (!fuzzyHumanRoleTokens.has(tokens[roleIndex]!)) continue;
    if (fuzzyHumanRequestIsNegated(tokens, roleIndex)) continue;
    const trailing = tokens.slice(roleIndex + 1);
    if (!humanRoleTrailingIsSafe(trailing)) continue;
    if (tokens.length === 1) return true;
    const leading = tokens.slice(0, roleIndex);
    if (leading.every((token) =>
      ["a", "actual", "an", "another", "just", "live", "me", "real", "the", "your"].includes(token) || fuzzyHumanPoliteTokens.has(token),
    )) return true;
    for (let cueIndex = 0; cueIndex < roleIndex; cueIndex += 1) {
      if (!fuzzyHumanCueTokens.has(tokens[cueIndex]!)) continue;
      const fillers = tokens.slice(cueIndex + 1, roleIndex);
      if (fillers.every((token) =>
        fuzzyHumanFillers.has(token) || fuzzyHumanPoliteTokens.has(token),
      )) return true;
    }
  }
  return false;
}

function fuzzyHumanInabilityRequested(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  for (let roleIndex = 0; roleIndex < tokens.length; roleIndex += 1) {
    if (!fuzzyHumanRoleTokens.has(tokens[roleIndex]!)) continue;
    if (!humanRoleTrailingIsSafe(tokens.slice(roleIndex + 1))) continue;
    for (let negativeIndex = 0; negativeIndex < roleIndex; negativeIndex += 1) {
      if (!["cannot", "cant", "couldnt", "doesnt", "wont"].includes(tokens[negativeIndex]!)) continue;
      const scope = tokens.slice(negativeIndex + 1, roleIndex);
      const requesterContext = tokens.slice(0, negativeIndex + 2);
      const hasFirstPerson = negativeIndex === 0 ||
        requesterContext.includes("i") ||
        requesterContext.some((token) => ["bot", "chatbot", "it", "robot", "this", "you"].includes(token));
      const hasConnectionAction = scope.some((token) =>
        ["chat", "conect", "connect", "contact", "get", "reach", "speak", "spk", "tak", "talk", "tlk"].includes(token),
      );
      if (hasFirstPerson && hasConnectionAction) return true;
    }
  }
  return false;
}

function cueIsExplicitlyNegated(tokens: readonly string[], cueIndex: number): boolean {
  const preceding = tokens.slice(Math.max(0, cueIndex - 3), cueIndex);
  return preceding.some((token) => fuzzyHumanNegationTokens.has(token));
}

function explicitlyPrefersBotOrRefusesHuman(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  for (let targetIndex = 0; targetIndex < tokens.length; targetIndex += 1) {
    const target = tokens[targetIndex]!;
    if (["bot", "bots", "chatbot", "chatbots", "robot"].includes(target)) {
      for (let cueIndex = Math.max(0, targetIndex - 5); cueIndex < targetIndex; cueIndex += 1) {
        if (!["choose", "keep", "like", "need", "prefer", "use", "want"].includes(tokens[cueIndex]!)) continue;
        if (!tokens.slice(cueIndex + 1, targetIndex).every((token) =>
          ["a", "an", "only", "really", "the", "this"].includes(token),
        )) continue;
        if (!cueIsExplicitlyNegated(tokens, cueIndex)) return true;
      }
      continue;
    }
    if (target !== "one" && !fuzzyHumanRoleTokens.has(target)) continue;
    for (let cueIndex = Math.max(0, targetIndex - 5); cueIndex < targetIndex; cueIndex += 1) {
      if (!["ask", "asking", "have", "need", "prefer", "request", "requesting", "want"].includes(tokens[cueIndex]!)) continue;
      if (cueIsExplicitlyNegated(tokens, cueIndex)) return true;
    }
  }
  return false;
}

function botRoutesToHuman(clause: string): boolean {
  const tokens = humanRequestTokens(clause);
  for (let botIndex = 0; botIndex < tokens.length; botIndex += 1) {
    if (!["bot", "bots", "chatbot", "chatbots", "robot"].includes(tokens[botIndex]!)) continue;
    for (let routeIndex = botIndex + 1; routeIndex < tokens.length; routeIndex += 1) {
      if (!["conect", "connect", "forward", "pass", "route", "tranfer", "transfer"].includes(tokens[routeIndex]!)) {
        continue;
      }
      const negativeBeforeBot = tokens.slice(0, botIndex).some((token) =>
        fuzzyHumanNegationTokens.has(token),
      );
      const contrastAfterBot = tokens.slice(botIndex + 1, routeIndex).some((token) =>
        ["and", "but", "instead"].includes(token),
      );
      if ((negativeBeforeBot && !contrastAfterBot) || cueIsExplicitlyNegated(tokens, routeIndex)) {
        continue;
      }
      for (let roleIndex = routeIndex + 1; roleIndex < tokens.length; roleIndex += 1) {
        if (
          fuzzyHumanRoleTokens.has(tokens[roleIndex]!) &&
          humanRoleTrailingIsSafe(tokens.slice(roleIndex + 1))
        ) return true;
      }
    }
  }
  return false;
}

function rejectedBotThenRequestedHuman(text: string): boolean {
  const tokens = humanRequestTokens(text);
  for (let botIndex = 0; botIndex < tokens.length; botIndex += 1) {
    if (!["bot", "bots", "chatbot", "chatbots", "robot"].includes(tokens[botIndex]!)) continue;
    if (!tokens.slice(0, botIndex).some((token) => fuzzyHumanNegationTokens.has(token))) {
      continue;
    }
    const afterBot = tokens.slice(botIndex + 1);
    const hasContrast = ["and", "but", "instead", "just"].includes(afterBot[0] ?? "") ||
      (
        ["i", "we"].includes(afterBot[0] ?? "") &&
        ["get", "need", "prefer", "want"].includes(afterBot[1] ?? "")
      );
    if (hasContrast && fuzzyHumanRequested(afterBot.join(" "))) return true;
  }
  return false;
}

function leadingNoThenRequestedHuman(text: string): boolean {
  const tokens = humanRequestTokens(text);
  return tokens[0] === "no" && tokens[1] === "i" && fuzzyHumanRequested(tokens.slice(1).join(" "));
}

export function humanRequested(text: string): boolean {
  const input = text.trim();
  if (
    humanMentionQuestionPattern.test(input) ||
    humanMetaQuestionPattern.test(input) ||
    humanThirdPartyQuestionPattern.test(input) ||
    metaReportedHumanPattern.test(input)
  ) return false;
  const reportedAcrossBoundary = reportedHumanRequestAcrossBoundaryPattern.exec(input);
  if (
    reportedAcrossBoundary !== null &&
    /[:,—–]|\s(?:-|\/)\s/u.test(reportedAcrossBoundary[0])
  ) {
    const remainder = input.slice(reportedAcrossBoundary.index + reportedAcrossBoundary[0].length);
    const laterSentence = /^[.!?\n]+\s*(.+)$/u.exec(remainder);
    if (laterSentence !== null) return humanRequested(laterSentence[1]!);
    const laterCommand = /^\s*[;,—–-]+\s*(?:and\s+)?(?:now\s+)?(.+)$/iu.exec(remainder);
    if (laterCommand !== null) return humanRequested(laterCommand[1]!);
    const contrast = /\b(?:but|however|instead)\b/iu.exec(remainder);
    return contrast === null
      ? false
      : humanRequested(remainder.slice(contrast.index + contrast[0].length));
  }
  const clauses = input
    .replace(/\bno\s*[,—–-]\s*(?:thanks|thank\s+you)\b/giu, "no thanks")
    .replace(/\bon\s+second\s+thought\s*[,—–-]\s*no\b/giu, "on second thought no")
    .replace(/\bwait\s*[,—–-]\s*no\b/giu, "wait no")
    .split(humanClauseSeparator)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  let decision: boolean | null = null;
  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
      const clause = clauses[clauseIndex]!;
      const hasPriorHumanReference = clauses.slice(0, clauseIndex).some((priorClause) =>
        humanRequestTokens(priorClause).some((token) => fuzzyHumanRoleTokens.has(token)),
      );
      if (hasPriorHumanReference && humanCurrentReversalPattern.test(clause)) {
        decision = true;
        continue;
      }
      if (humanRetractionPattern.test(clause)) {
        decision = false;
        continue;
      }
      if (leadingNoThenRequestedHuman(clause)) {
        decision = true;
        continue;
      }
      if (
        humanMentionQuestionPattern.test(clause) ||
        humanMetaQuestionPattern.test(clause) ||
        humanThirdPartyQuestionPattern.test(clause) ||
        humanConditionalMentionPattern.test(clause) ||
        humanNonSupportServicePattern.test(clause) ||
        humanNonSupportContextPattern.test(clause) ||
        humanRoleHasUnsupportedPurpose(clause) ||
        reportedHumanRequestPattern.test(clause) ||
        historicalHumanRequestPattern.test(clause) ||
        historicalReportedHumanPattern.test(clause) ||
        earlierReportedHumanPattern.test(clause) ||
        metaReportedHumanPattern.test(clause) ||
        humanRefusalContextPattern.test(clause)
      ) {
        decision = false;
        continue;
      }
      if (botRoutesToHuman(clause)) {
        decision = true;
        continue;
      }
      if (explicitlyPrefersBotOrRefusesHuman(clause)) {
        decision = false;
        continue;
      }
      if (
        humanInabilityPattern.test(clause) ||
        fuzzyHumanInabilityRequested(clause) ||
        rejectedBotThenRequestedHuman(clause)
      ) {
        decision = true;
        continue;
      }
      if (
        negatedHumanRequestPattern.test(clause) ||
        fuzzyHumanClauseIsNegated(clause)
      ) {
        decision = false;
        continue;
      }
      if (
        humanOnlyPattern.test(clause) ||
        humanActionPattern.test(clause) ||
        humanWantPattern.test(clause) ||
        humanQueryPattern.test(clause) ||
        humanPreferencePattern.test(clause) ||
        humanRolelessHandoffPattern.test(clause) ||
        humanColloquialHandoffPattern.test(clause) ||
        humanPassiveHandoffPattern.test(clause) ||
        humanDirectRoutePattern.test(clause) ||
        humanAnaphoricHandoffPattern.test(clause) ||
        fuzzyRolelessHandoffPattern.test(clause) ||
        fuzzyHumanRequested(clause)
      ) {
        decision = true;
      }
    }
  return decision ?? false;
}
