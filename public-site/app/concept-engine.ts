export type EvidenceKind =
  | "duplicate_charge"
  | "late_delivery"
  | "wrong_item"
  | "account_locked";

export type EvidenceSignal = {
  id: EvidenceKind;
  label: string;
  evidence: string;
  evidenceId: string;
};

export type AssistChoice = {
  id: string;
  label: string;
  confirmation: string;
  supporting: string;
  evidenceId: string | null;
  kind: "grounded" | "escape";
  score: number;
};

export type AssistDecision =
  | {
      outcome: "show_grounded_choices";
      prompt: string;
      choices: AssistChoice[];
      selectionBasis: "concept_match" | "ambiguous_message" | "account_context_fallback";
      legibility: number;
    }
  | {
      outcome: "continue_host_bot";
      choices: [];
      selectionBasis: "no_supported_match";
      legibility: number;
    };

type ConceptCandidate = {
  id: string;
  evidenceKind: EvidenceKind;
  label: string;
  confirmation: string;
  aliases: readonly string[];
  concept: Partial<Record<ConceptAxis, number>>;
  contextPriority: number;
};

type RankedCandidate = ConceptCandidate & {
  score: number;
  conceptSimilarity: number;
  characterSimilarity: number;
  fuzzySimilarity: number;
  evidenceCompatibility: number;
};

const conceptAxes = [
  "billing",
  "delivery",
  "item",
  "access",
  "duplicate",
  "late",
  "mismatch",
  "locked",
  "refund",
  "explain",
  "tracking",
  "date",
  "replacement",
  "return",
  "password",
] as const;

type ConceptAxis = (typeof conceptAxes)[number];

export const evidenceSignals: readonly EvidenceSignal[] = [
  {
    id: "duplicate_charge",
    label: "Two matching charges",
    evidence: "Two completed $84 charges for one order",
    evidenceId: "payment:synthetic-1842",
  },
  {
    id: "late_delivery",
    label: "Shipment past due",
    evidence: "One shipment is past its expected date",
    evidenceId: "shipment:synthetic-4821",
  },
  {
    id: "wrong_item",
    label: "Item does not match",
    evidence: "The delivered item differs from the order",
    evidenceId: "order:synthetic-7304",
  },
  {
    id: "account_locked",
    label: "Sign-in blocked",
    evidence: "The account is locked after four failed attempts",
    evidenceId: "account:synthetic-2259",
  },
] as const;

const candidates: readonly ConceptCandidate[] = [
  {
    id: "duplicate_payment",
    evidenceKind: "duplicate_charge",
    label: "I was charged twice",
    confirmation: "The synthetic record shows two completed $84 charges for the same order. No refund or account change was made.",
    aliases: ["charged twice", "paid two times", "double payment", "same charge again", "money taken twice", "card billed twice"],
    concept: { billing: 1, duplicate: 1 },
    contextPriority: 1,
  },
  {
    id: "refund_extra_payment",
    evidenceKind: "duplicate_charge",
    label: "Refund the extra charge",
    confirmation: "The extra charge is supported by this synthetic record. A real company would continue in its existing refund workflow.",
    aliases: ["refund extra charge", "give money back", "reverse second payment", "remove duplicate charge", "refund one payment"],
    concept: { billing: 0.85, duplicate: 0.8, refund: 1 },
    contextPriority: 0.78,
  },
  {
    id: "explain_two_payments",
    evidenceKind: "duplicate_charge",
    label: "Explain the two charges",
    confirmation: "This synthetic account contains two matching completed charges. A real company would open its billing explanation flow.",
    aliases: ["explain charges", "why two payments", "what are these charges", "check both charges", "understand card payments"],
    concept: { billing: 1, duplicate: 0.75, explain: 1 },
    contextPriority: 0.68,
  },
  {
    id: "delivery_late",
    evidenceKind: "late_delivery",
    label: "My delivery is late",
    confirmation: "The synthetic shipment is marked late and its expected date has passed. No order change was made.",
    aliases: ["delivery is late", "package never came", "parcel not here", "shipment delayed", "order has not arrived", "still waiting for package"],
    concept: { delivery: 1, late: 1 },
    contextPriority: 1,
  },
  {
    id: "track_delivery",
    evidenceKind: "late_delivery",
    label: "Where is my package?",
    confirmation: "The synthetic record supports a shipment-status request. A real company would continue in its tracking flow.",
    aliases: ["where is package", "track my parcel", "shipment status", "find my delivery", "where did order go", "tracking update"],
    concept: { delivery: 1, late: 0.35, tracking: 1 },
    contextPriority: 0.78,
  },
  {
    id: "new_delivery_date",
    evidenceKind: "late_delivery",
    label: "Tell me the new delivery date",
    confirmation: "This synthetic shipment is past its expected date. A real company would request an updated estimate from its delivery system.",
    aliases: ["new delivery date", "when will it arrive", "updated arrival time", "expected date", "how much longer", "delivery estimate"],
    concept: { delivery: 0.9, late: 0.65, date: 1 },
    contextPriority: 0.66,
  },
  {
    id: "received_wrong_item",
    evidenceKind: "wrong_item",
    label: "I received the wrong item",
    confirmation: "The synthetic record shows that the delivered item does not match the order. No return or replacement was created.",
    aliases: ["wrong item arrived", "not what I ordered", "different thing in box", "incorrect product", "sent me wrong one", "order does not match"],
    concept: { item: 1, mismatch: 1 },
    contextPriority: 1,
  },
  {
    id: "replace_wrong_item",
    evidenceKind: "wrong_item",
    label: "Send the item I ordered",
    confirmation: "The mismatch is supported by this synthetic order. A real company would continue in its replacement workflow.",
    aliases: ["replace wrong item", "send correct product", "want the right one", "exchange incorrect item", "item I ordered", "replacement please"],
    concept: { item: 1, mismatch: 0.7, replacement: 1 },
    contextPriority: 0.78,
  },
  {
    id: "return_wrong_item",
    evidenceKind: "wrong_item",
    label: "Help me return this item",
    confirmation: "The item mismatch is supported by this synthetic order. A real company would continue in its return workflow.",
    aliases: ["return wrong item", "send this back", "return the product", "need a return label", "take back incorrect order"],
    concept: { item: 1, mismatch: 0.55, return: 1 },
    contextPriority: 0.66,
  },
  {
    id: "cannot_sign_in",
    evidenceKind: "account_locked",
    label: "I can’t sign in",
    confirmation: "The synthetic record shows a locked account after four failed sign-in attempts. No account change was made.",
    aliases: ["cannot sign in", "cant get in", "login does not work", "access blocked", "unable to log in", "account stops me"],
    concept: { access: 1, locked: 0.85 },
    contextPriority: 1,
  },
  {
    id: "unlock_account",
    evidenceKind: "account_locked",
    label: "Unlock my account",
    confirmation: "The locked state is supported by this synthetic record. A real company would continue in its secure unlock workflow.",
    aliases: ["unlock account", "remove account lock", "let me back in", "unblock login", "restore access", "open my account"],
    concept: { access: 1, locked: 1 },
    contextPriority: 0.78,
  },
  {
    id: "reset_password",
    evidenceKind: "account_locked",
    label: "Help me reset my password",
    confirmation: "This synthetic account is locked. A real company would continue in its identity-verified password reset flow.",
    aliases: ["reset password", "forgot password", "password does not work", "need new password", "change login code", "recover access"],
    concept: { access: 0.85, locked: 0.35, password: 1 },
    contextPriority: 0.66,
  },
] as const;

const vocabulary: Readonly<Record<string, readonly ConceptAxis[]>> = {
  money: ["billing"], payment: ["billing"], payments: ["billing"], pay: ["billing"], paid: ["billing"],
  card: ["billing"], bill: ["billing"], billed: ["billing"], charge: ["billing"], charges: ["billing"], charged: ["billing"],
  package: ["delivery"], parcel: ["delivery"], delivery: ["delivery"], shipment: ["delivery"], shipping: ["delivery"],
  arrive: ["delivery"], arrived: ["delivery"], came: ["delivery"], come: ["delivery"], waiting: ["delivery", "late"],
  item: ["item"], product: ["item"], thing: ["item"], box: ["item"], order: ["item"], ordered: ["item"],
  login: ["access"], signin: ["access"], access: ["access"], account: ["access"], enter: ["access"],
  twice: ["duplicate"], double: ["duplicate"], duplicate: ["duplicate"], again: ["duplicate"], second: ["duplicate"], two: ["duplicate"], same: ["duplicate"],
  late: ["late"], delayed: ["late"], delay: ["late"], missing: ["late"], never: ["late"], overdue: ["late"], longer: ["late", "date"],
  wrong: ["mismatch"], different: ["mismatch"], incorrect: ["mismatch"], mismatch: ["mismatch"], match: ["mismatch"],
  locked: ["locked", "access"], lock: ["locked", "access"], blocked: ["locked", "access"], stuck: ["locked"], unable: ["locked"], cannot: ["locked"], cant: ["locked"],
  refund: ["refund"], repay: ["refund"], reverse: ["refund"], back: ["refund", "return"],
  explain: ["explain"], why: ["explain"], understand: ["explain"], check: ["explain"],
  track: ["tracking"], tracking: ["tracking"], status: ["tracking"], where: ["tracking"], find: ["tracking"],
  date: ["date"], estimate: ["date"], expected: ["date"],
  replace: ["replacement"], replacement: ["replacement"], correct: ["replacement"], right: ["replacement"], exchange: ["replacement"],
  return: ["return"], label: ["return"], sendback: ["return"],
  password: ["password", "access"], passcode: ["password", "access"], code: ["password"], reset: ["password", "access"], recover: ["password", "access"],
};

const ordinaryWords = new Set([
  "a", "about", "address", "agent", "am", "an", "and", "are", "blue", "can", "cancel", "change", "close", "color", "contact", "could", "coupon", "email", "evening",
  "for", "get", "good", "hello", "help", "hey", "hi", "hours", "how", "i", "in", "invoice", "is", "like", "mailing", "open",
  "me", "my", "need", "of", "on", "or", "person", "please", "proof", "receipt", "representative", "someone", "store",
  "shirt", "shirts", "size", "subscription", "support", "the", "there", "this", "to", "update", "want", "was", "what", "when", "with", "would", "you", "your",
]);

const axisIndex = new Map<ConceptAxis, number>(conceptAxes.map((axis, index) => [axis, index]));
const vocabularyWords = Object.keys(vocabulary);
const HASH_DIMENSIONS = 128;
const evidenceSalience: Readonly<Record<EvidenceKind, number>> = {
  account_locked: 1,
  late_delivery: 0.96,
  duplicate_charge: 0.92,
  wrong_item: 0.88,
};

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\bsign\s+in\b/g, "signin")
    .replace(/\blog\s+in\b/g, "login")
    .replace(/\bsend\s+back\b/g, "sendback")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  const value = normalize(text);
  return value ? value.split(/\s+/) : [];
}

function damerauLevenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0][column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitution,
      );
      if (
        row > 1
        && column > 1
        && left[row - 1] === right[column - 2]
        && left[row - 2] === right[column - 1]
      ) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + substitution);
      }
    }
  }
  return matrix[left.length][right.length];
}

function wordSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (Math.min(left.length, right.length) < 3) return 0;
  const distance = damerauLevenshtein(left, right);
  const edit = 1 - distance / Math.max(left.length, right.length);
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  let cursor = 0;
  for (const character of longer) {
    if (character === shorter[cursor]) cursor += 1;
  }
  const subsequence = cursor / shorter.length;
  const lengthBalance = shorter.length / longer.length;
  return Math.max(edit, subsequence * lengthBalance * 0.82);
}

function closestVocabularyWord(token: string): { word: string; score: number } | null {
  let bestWord = "";
  let bestScore = 0;
  for (const word of vocabularyWords) {
    const score = wordSimilarity(token, word);
    if (score > bestScore) {
      bestWord = word;
      bestScore = score;
    }
  }
  const threshold = token.length >= 5 ? 0.58 : token.length >= 4 ? 0.55 : 0.72;
  return bestScore >= threshold ? { word: bestWord, score: bestScore } : null;
}

function conceptVector(text: string): number[] {
  const vector = Array<number>(conceptAxes.length).fill(0);
  const normalizedText = normalize(text);
  const inputTokens = tokens(text);
  for (const token of inputTokens) {
    if (ordinaryWords.has(token) && !vocabulary[token]) continue;
    const match = vocabulary[token] ? { word: token, score: 1 } : closestVocabularyWord(token);
    if (!match) continue;
    for (const axis of vocabulary[match.word]) {
      vector[axisIndex.get(axis) ?? 0] += match.score;
    }
  }
  if (/\b(?:no|not)\b.{0,16}\b(?:same|match|ordered|picked)\b/.test(normalizedText)) {
    vector[axisIndex.get("mismatch") ?? 0] += 1;
  }
  if (/\b(?:cant|cannot|unable)\b.{0,16}\b(?:get|enter|signin|login)\b/.test(normalizedText)) {
    vector[axisIndex.get("access") ?? 0] += 1;
    vector[axisIndex.get("locked") ?? 0] += 0.7;
  }
  const resemblesAny = (token: string, words: readonly string[], threshold: number) => (
    words.some((word) => wordSimilarity(token, word) >= threshold)
  );
  const hasDeliveryObject = inputTokens.some((token) => resemblesAny(
    token,
    ["package", "parcel", "delivery", "shipment"],
    0.54,
  ));
  const hasNonArrival = inputTokens.some((token) => resemblesAny(
    token,
    ["no", "not", "never"],
    0.54,
  ));
  const hasArrivalVerb = inputTokens.some((token) => resemblesAny(
    token,
    ["come", "came", "arrive", "arrived"],
    0.54,
  ));
  if (hasDeliveryObject && hasNonArrival && hasArrivalVerb) {
    vector[axisIndex.get("delivery") ?? 0] += 1;
    vector[axisIndex.get("late") ?? 0] += 1;
  }
  return vector;
}

function explicitConceptVector(concept: ConceptCandidate["concept"]): number[] {
  return conceptAxes.map((axis) => concept[axis] ?? 0);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function characterVector(text: string): number[] {
  const normalized = normalize(text);
  const vector = Array<number>(HASH_DIMENSIONS).fill(0);
  if (!normalized) return vector;
  const value = ` ${normalized} `;
  for (const size of [2, 3]) {
    for (let index = 0; index <= value.length - size; index += 1) {
      const gram = value.slice(index, index + size);
      const hash = stableHash(`${size}:${gram}`);
      vector[hash % HASH_DIMENSIONS] += (hash & 1) === 0 ? 1 : -1;
    }
  }
  return vector;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftLength += left[index] * left[index];
    rightLength += right[index] * right[index];
  }
  if (leftLength === 0 || rightLength === 0) return 0;
  return Math.max(0, dot / Math.sqrt(leftLength * rightLength));
}

function fuzzyCandidateSimilarity(message: string, candidate: ConceptCandidate): number {
  const inputTokens = tokens(message).filter((token) => !ordinaryWords.has(token));
  if (inputTokens.length === 0) return 0;
  const candidateTokens = tokens(`${candidate.label} ${candidate.aliases.join(" ")}`)
    .filter((token) => !ordinaryWords.has(token));
  const scores = inputTokens.map((input) => {
    let best = 0;
    for (const candidateToken of candidateTokens) {
      best = Math.max(best, wordSimilarity(input, candidateToken));
    }
    return best;
  }).sort((left, right) => right - left);
  return scores.slice(0, Math.min(3, scores.length)).reduce((sum, score) => sum + score, 0)
    / Math.min(3, scores.length);
}

function conceptValue(vector: readonly number[], axis: ConceptAxis): number {
  return vector[axisIndex.get(axis) ?? 0] ?? 0;
}

function evidenceCompatibility(vector: readonly number[], kind: EvidenceKind): number {
  const detail = (...axes: ConceptAxis[]) => Math.max(...axes.map((axis) => conceptValue(vector, axis)));
  switch (kind) {
    case "duplicate_charge":
      return Math.min(conceptValue(vector, "billing"), detail("duplicate", "refund", "explain"));
    case "late_delivery":
      return Math.min(conceptValue(vector, "delivery"), detail("late", "tracking", "date"));
    case "wrong_item":
      return Math.min(conceptValue(vector, "item"), detail("mismatch", "replacement", "return"));
    case "account_locked":
      return Math.min(conceptValue(vector, "access"), detail("locked", "password"));
  }
}

function messageLegibility(message: string): number {
  const inputTokens = tokens(message);
  if (inputTokens.length === 0) return 0;
  let known = 0;
  let wordLike = 0;
  for (const token of inputTokens) {
    if (ordinaryWords.has(token) || vocabulary[token] || closestVocabularyWord(token)) known += 1;
    if (token.length <= 2 || /[aeiouy]/.test(token)) wordLike += 1;
  }
  return 0.68 * (known / inputTokens.length) + 0.32 * (wordLike / inputTokens.length);
}

function rankCandidates(message: string): RankedCandidate[] {
  const queryConcept = conceptVector(message);
  const queryCharacters = characterVector(message);
  return candidates
    .map((candidate) => {
      const conceptSimilarity = cosineSimilarity(queryConcept, explicitConceptVector(candidate.concept));
      const characterSimilarity = Math.max(
        ...candidate.aliases.map((alias) => cosineSimilarity(queryCharacters, characterVector(alias))),
        cosineSimilarity(queryCharacters, characterVector(candidate.label)),
      );
      const fuzzySimilarity = fuzzyCandidateSimilarity(message, candidate);
      const compatibility = evidenceCompatibility(queryConcept, candidate.evidenceKind);
      const score = (
        conceptSimilarity * 0.54
        + characterSimilarity * 0.18
        + fuzzySimilarity * 0.2
        + candidate.contextPriority * evidenceSalience[candidate.evidenceKind] * 0.08
      );
      return {
        ...candidate,
        score,
        conceptSimilarity,
        characterSimilarity,
        fuzzySimilarity,
        evidenceCompatibility: compatibility,
      };
    })
    .sort((left, right) => right.score - left.score || right.contextPriority - left.contextPriority);
}

function evidenceByKind(kind: EvidenceKind): EvidenceSignal {
  const evidence = evidenceSignals.find((signal) => signal.id === kind);
  if (!evidence) throw new Error(`Unknown evidence signal: ${kind}`);
  return evidence;
}

function toChoice(candidate: RankedCandidate): AssistChoice {
  const evidence = evidenceByKind(candidate.evidenceKind);
  return {
    id: candidate.id,
    label: candidate.label,
    confirmation: candidate.confirmation,
    supporting: `Grounded in ${evidence.evidence.toLowerCase()}`,
    evidenceId: evidence.evidenceId,
    kind: "grounded",
    score: Number(candidate.score.toFixed(3)),
  };
}

export function assistMessage(
  message: string,
  options: { forceChoices?: boolean } = {},
): AssistDecision {
  const normalized = normalize(message);
  const legibility = messageLegibility(message);
  const messageRanked = rankCandidates(message);
  const best = messageRanked[0];
  const second = messageRanked[1];
  const isEmpty = normalized.length === 0;
  const isLowLegibility = !isEmpty && legibility < 0.48;
  const contentTokens = tokens(message).filter((token) => !ordinaryWords.has(token));
  const queryConcept = conceptVector(message);
  const distinctiveFragment = contentTokens.length === 1 && [
    "billing", "duplicate", "late", "mismatch", "locked", "refund", "tracking", "replacement", "return", "password",
  ].some((axis) => conceptValue(queryConcept, axis as ConceptAxis) > 0);
  const domainCount = (["billing", "delivery", "item", "access"] as const)
    .filter((axis) => conceptValue(queryConcept, axis) > 0).length;
  const multiDomainFragment = domainCount >= 2;
  const hasSupportedMatch = Boolean(
    best
    && best.score >= 0.3
    && (
      best.evidenceCompatibility >= 0.5
      || distinctiveFragment
      || multiDomainFragment
    ),
  );
  const sparseContextCue = !hasSupportedMatch
    && tokens(message).length <= 3
    && (["duplicate", "late", "mismatch", "locked", "refund", "tracking", "replacement", "return", "password"] as const)
      .some((axis) => conceptValue(queryConcept, axis) > 0);

  if (!options.forceChoices && !isEmpty && !isLowLegibility && !sparseContextCue && !hasSupportedMatch) {
    return {
      outcome: "continue_host_bot",
      choices: [],
      selectionBasis: "no_supported_match",
      legibility: Number(legibility.toFixed(3)),
    };
  }

  const weakOrAmbiguous = !best
    || best.score < 0.5
    || (second ? best.score - second.score < 0.1 : false);
  const selectionBasis = isEmpty || isLowLegibility || sparseContextCue || (options.forceChoices && !hasSupportedMatch)
    ? "account_context_fallback"
    : weakOrAmbiguous
      ? "ambiguous_message"
      : "concept_match";
  const prompt = isEmpty
    ? "No words needed. I can use the account information already here. Which is closest?"
    : isLowLegibility || sparseContextCue
      ? "That’s okay — I’m not sure what you meant yet. These account details may help."
      : selectionBasis === "account_context_fallback"
        ? "I can use the account information already here. Which is closest?"
        : weakOrAmbiguous || options.forceChoices
          ? "I matched parts of your message. Which choice is closest?"
          : "I matched your message by meaning. Which choice is closest?";

  const ranked = selectionBasis === "account_context_fallback" ? rankCandidates("") : messageRanked;
  const grounded = ranked.slice(0, 2).map(toChoice);
  const escape: AssistChoice = {
    id: "something_else",
    label: "Something else — keep typing",
    confirmation: "That’s okay. Type any words you have, or preview a human handoff.",
    supporting: "Continue with the normal support chat",
    evidenceId: null,
    kind: "escape",
    score: 0,
  };

  return {
    outcome: "show_grounded_choices",
    prompt,
    choices: [...grounded, escape],
    selectionBasis,
    legibility: Number(legibility.toFixed(3)),
  };
}

export const conceptEngineInternals = {
  characterVector,
  conceptVector,
  cosineSimilarity,
  messageLegibility,
  wordSimilarity,
};
