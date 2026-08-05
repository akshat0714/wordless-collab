export type DetectorStatus = "proposed" | "approved" | "edited" | "rejected";

export type DetectorSample = {
  id: string;
  fragment: string;
  evidence: string;
};

export type Detector = {
  id: string;
  label: string;
  condition: string;
  supportNumerator: number;
  supportDenominator: number;
  assertionNumerator: number;
  assertionDenominator: number;
  variants: string[];
  status: DetectorStatus;
  assertions: DetectorSample[];
  contrasts: DetectorSample[];
};

const cleanContrasts = {
  duplicate: [
    { id: "demo-009", fragment: "where receipt", evidence: "1 / 1 charge succeeded; no second charge exists." },
    { id: "demo-019", fragment: "could you send the receipt for my recent purchase", evidence: "1 / 1 charge succeeded; no second charge exists." },
    { id: "demo-029", fragment: "I am preparing my monthly records and would like a copy of the receipt for the completed order", evidence: "1 / 1 charge succeeded; no second charge exists." },
  ],
  delivery: [
    { id: "demo-009", fragment: "where receipt", evidence: "Order status is delivered; no open overdue shipment." },
    { id: "demo-019", fragment: "could you send the receipt for my recent purchase", evidence: "Order status is delivered; no open overdue shipment." },
    { id: "demo-029", fragment: "I am preparing my monthly records and would like a copy of the receipt for the completed order", evidence: "Order status is delivered; no open overdue shipment." },
  ],
  item: [
    { id: "demo-009", fragment: "where receipt", evidence: "MUG-WHITE ordered; MUG-WHITE delivered." },
    { id: "demo-019", fragment: "could you send the receipt for my recent purchase", evidence: "MUG-WHITE ordered; MUG-WHITE delivered." },
    { id: "demo-029", fragment: "I am preparing my monthly records and would like a copy of the receipt for the completed order", evidence: "MUG-WHITE ordered; MUG-WHITE delivered." },
  ],
  account: [
    { id: "demo-009", fragment: "where receipt", evidence: "Account active; 0 failed sign-in attempts." },
    { id: "demo-019", fragment: "could you send the receipt for my recent purchase", evidence: "Account active; 0 failed sign-in attempts." },
    { id: "demo-029", fragment: "I am preparing my monthly records and would like a copy of the receipt for the completed order", evidence: "Account active; 0 failed sign-in attempts." },
  ],
};

export const detectors: Detector[] = [
  {
    id: "duplicate_charge",
    label: "You were charged twice",
    condition: "At least two succeeded charges have the same amount and occur no more than one hour apart.",
    supportNumerator: 6,
    supportDenominator: 30,
    assertionNumerator: 6,
    assertionDenominator: 6,
    variants: [
      "money one twice",
      "the card money appears two times on my account",
      "the same purchase amount appears there two separate times",
    ],
    status: "proposed",
    assertions: [
      { id: "demo-001", fragment: "money one twice", evidence: "2 / 2 $81.00 charges succeeded · 6 min apart" },
      { id: "demo-002", fragment: "money one twice", evidence: "2 / 2 $82.00 charges succeeded · 6 min apart" },
      { id: "demo-011", fragment: "the card money appears two times on my account", evidence: "2 / 2 $91.00 charges succeeded · 6 min apart" },
      { id: "demo-012", fragment: "the card money appears two times on my account", evidence: "2 / 2 $92.00 charges succeeded · 6 min apart" },
      { id: "demo-021", fragment: "I checked the bank page this morning and the same purchase amount appears there two separate times", evidence: "2 / 2 $101.00 charges succeeded · 6 min apart" },
      { id: "demo-022", fragment: "I checked the bank page this morning and the same purchase amount appears there two separate times", evidence: "2 / 2 $102.00 charges succeeded · 6 min apart" },
    ],
    contrasts: cleanContrasts.duplicate,
  },
  {
    id: "wrong_item",
    label: "The wrong item arrived",
    condition: "The ordered SKU differs from the delivered SKU on an exported order fact.",
    supportNumerator: 6,
    supportDenominator: 30,
    assertionNumerator: 6,
    assertionDenominator: 6,
    variants: [
      "order wrong thing help",
      "the box has a different thing than I ordered",
      "found a blue mug even though the order page shows a blue kettle",
    ],
    status: "proposed",
    assertions: [
      { id: "demo-005", fragment: "order wrong thing help", evidence: "KETTLE-BLUE ordered · MUG-BLUE delivered" },
      { id: "demo-006", fragment: "order wrong thing help", evidence: "KETTLE-BLUE ordered · MUG-BLUE delivered" },
      { id: "demo-015", fragment: "the box has a different thing than I ordered", evidence: "KETTLE-BLUE ordered · MUG-BLUE delivered" },
      { id: "demo-016", fragment: "the box has a different thing than I ordered", evidence: "KETTLE-BLUE ordered · MUG-BLUE delivered" },
      { id: "demo-025", fragment: "I opened the delivered box and found a blue mug even though the order page shows a blue kettle", evidence: "KETTLE-BLUE ordered · MUG-BLUE delivered" },
      { id: "demo-026", fragment: "I opened the delivered box and found a blue mug even though the order page shows a blue kettle", evidence: "KETTLE-BLUE ordered · MUG-BLUE delivered" },
    ],
    contrasts: cleanContrasts.item,
  },
  {
    id: "account_lock",
    label: "Your account is locked",
    condition: "The account is marked locked after at least three failed sign-in attempts.",
    supportNumerator: 6,
    supportDenominator: 30,
    assertionNumerator: 6,
    assertionDenominator: 6,
    variants: [
      "cannot get in",
      "the login keeps stopping me after I try it",
      "the sign in page will not let me continue after the earlier attempts",
    ],
    status: "proposed",
    assertions: [
      { id: "demo-007", fragment: "cannot get in", evidence: "Account locked · 4 failed attempts" },
      { id: "demo-008", fragment: "cannot get in", evidence: "Account locked · 5 failed attempts" },
      { id: "demo-017", fragment: "the login keeps stopping me after I try it", evidence: "Account locked · 5 failed attempts" },
      { id: "demo-018", fragment: "the login keeps stopping me after I try it", evidence: "Account locked · 3 failed attempts" },
      { id: "demo-027", fragment: "I remember the password now but the sign in page will not let me continue after the earlier attempts", evidence: "Account locked · 3 failed attempts" },
      { id: "demo-028", fragment: "I remember the password now but the sign in page will not let me continue after the earlier attempts", evidence: "Account locked · 4 failed attempts" },
    ],
    contrasts: cleanContrasts.account,
  },
  {
    id: "late_delivery",
    label: "Your delivery is late",
    condition: "The expected delivery time has passed and the exported shipment is not in a closed delivery state.",
    supportNumerator: 6,
    supportDenominator: 30,
    assertionNumerator: 6,
    assertionDenominator: 6,
    variants: [
      "still not come",
      "the parcel should be here but it is not",
      "the package was supposed to reach my house several days ago",
    ],
    status: "proposed",
    assertions: [
      { id: "demo-003", fragment: "still not come", evidence: "Due 2026-01-03 · status in transit" },
      { id: "demo-004", fragment: "still not come", evidence: "Due 2026-01-04 · status in transit" },
      { id: "demo-013", fragment: "the parcel should be here but it is not", evidence: "Due 2026-01-13 · status in transit" },
      { id: "demo-014", fragment: "the parcel should be here but it is not", evidence: "Due 2026-01-14 · status in transit" },
      { id: "demo-023", fragment: "The tracking page has not changed and the package was supposed to reach my house several days ago", evidence: "Due 2026-01-23 · status in transit" },
      { id: "demo-024", fragment: "The tracking page has not changed and the package was supposed to reach my house several days ago", evidence: "Due 2026-01-24 · status in transit" },
    ],
    contrasts: cleanContrasts.delivery,
  },
];

export const findings = [
  ["demo-002", "return policy", "You were charged twice", "$82.00 · 2 / 2 charges succeeded · 6 min apart"],
  ["demo-006", "password reset", "You received the wrong item", "KETTLE-BLUE ordered · MUG-BLUE delivered"],
  ["demo-008", "invoice request", "Your account is locked", "Account locked · 5 failed attempts"],
  ["demo-012", "return policy", "You were charged twice", "$92.00 · 2 / 2 charges succeeded · 6 min apart"],
  ["demo-016", "password reset", "You received the wrong item", "KETTLE-BLUE ordered · MUG-BLUE delivered"],
  ["demo-018", "invoice request", "Your account is locked", "Account locked · 3 failed attempts"],
  ["demo-022", "return policy", "You were charged twice", "$102.00 · 2 / 2 charges succeeded · 6 min apart"],
  ["demo-026", "password reset", "You received the wrong item", "KETTLE-BLUE ordered · MUG-BLUE delivered"],
  ["demo-028", "invoice request", "Your account is locked", "Account locked · 4 failed attempts"],
] as const;
