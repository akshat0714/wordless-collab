# Accessibility Conformance Report

Based on the ITI VPAT® 2.5Rev WCAG Edition (April 2025).

## Product and report information

| Field | Value |
|---|---|
| Product | `@wordless/sdk` confirmation-card browser surface |
| Product version | 0.3.0 |
| Report date | July 25, 2026 |
| Report scope | The standalone confirmation-card component in `sdk/src/index.ts` |
| Contact | The organization deploying this source package; no public support contact is configured in this local repository |
| Applicable standard | WCAG 2.2 Levels A and AA |
| Technologies | TypeScript-generated HTML and CSS in a host web page |

## Product description

Wordless confirm cards render zero to three evidence-backed choices and a
“None of these” action. The framework-agnostic package has zero runtime
dependencies and can be loaded as an npm module or browser script. This report
does not cover the host page, customer-authored candidate content, downstream
behavior invoked by callbacks, the Node-only chat-assist client/adapter added in
version 0.3.0, or accessibility changes made by host CSS.

## Evaluation methods

- Automated axe-core analysis of the rendered component in the included
  Vitest/jsdom suite, with zero reported violations.
- Programmatic keyboard testing of native-button activation, focus restoration,
  and optional arrow-key navigation.
- Source review of names, roles, values, live-region behavior, focus indicators,
  forced-colors behavior, reduced motion, reflow, and target size.
- Contrast review against WCAG thresholds for the package's default palette.
- Runtime validation tests for candidate count, concise copy, concrete evidence,
  duplicate IDs, and non-empty accessible labels.

No independent third-party audit or named screen-reader/browser matrix has been
completed. Conformance statements apply to the unmodified component with its
default styles and valid inputs.

## Conformance terms

- **Supports:** The evaluated component provides at least one method that meets
  the criterion without a known defect in scope.
- **Partially Supports:** Some functionality meets the criterion, but a known
  in-scope limitation remains.
- **Does Not Support:** The evaluated component does not meet the criterion.
- **Not Applicable:** The criterion does not apply to this component's content
  or behavior. Host-page responsibilities are identified in the remarks.
- **Not Evaluated:** The criterion was not evaluated.

## WCAG 2.2 Level A

| Criterion | Conformance | Remarks and explanations |
|---|---|---|
| 1.1.1 Non-text Content | Supports | The only non-text selection glyph is accompanied by the word “Selected”; the component renders no informative images. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | Not Applicable | The component contains no audio or video. |
| 1.2.2 Captions (Prerecorded) | Not Applicable | The component contains no synchronized media. |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Not Applicable | The component contains no synchronized media. |
| 1.3.1 Info and Relationships | Supports | A labeled section, heading, list, list items, and native buttons expose structure programmatically. |
| 1.3.2 Meaningful Sequence | Supports | DOM order matches visual and keyboard order. |
| 1.3.3 Sensory Characteristics | Supports | Instructions do not depend on shape, color, sound, location, or orientation. |
| 1.4.1 Use of Color | Supports | Selection uses `aria-pressed`, a check glyph, and the text “Selected,” not color alone. |
| 1.4.2 Audio Control | Not Applicable | The component produces no audio. |
| 2.1.1 Keyboard | Supports | Every action is a native button operable with Tab, Enter, and Space; arrow keys optionally move among candidate buttons. |
| 2.1.2 No Keyboard Trap | Supports | Focus can enter and leave with standard browser navigation; no modal or trap exists. |
| 2.1.4 Character Key Shortcuts | Not Applicable | The component defines no letter, number, punctuation, or symbol shortcut. |
| 2.2.1 Timing Adjustable | Not Applicable | No timeout or time limit exists. |
| 2.2.2 Pause, Stop, Hide | Not Applicable | No automatically moving, blinking, scrolling, or updating content exists. |
| 2.3.1 Three Flashes or Below Threshold | Supports | The component never flashes. |
| 2.4.1 Bypass Blocks | Not Applicable | Page-level repeated-block navigation belongs to the host page. |
| 2.4.2 Page Titled | Not Applicable | The package does not create or own the host document title. |
| 2.4.3 Focus Order | Supports | Focus follows DOM order and returns to the activated replacement button after rerendering. |
| 2.4.4 Link Purpose (In Context) | Not Applicable | The component renders no links. |
| 2.5.1 Pointer Gestures | Supports | Every pointer action is a simple single click or tap. |
| 2.5.2 Pointer Cancellation | Supports | Native button click activation provides standard down-event cancellation behavior. |
| 2.5.3 Label in Name | Supports | Visible button titles and “None of these” text are contained in their accessible names. |
| 2.5.4 Motion Actuation | Not Applicable | No device-motion or user-motion input exists. |
| 3.1.1 Language of Page | Not Applicable | The host document owns its `lang` declaration; all default component strings are English and may be localized. |
| 3.2.1 On Focus | Supports | Receiving focus does not activate, select, navigate, or change context. |
| 3.2.2 On Input | Supports | Selection invokes the documented callback and updates pressed state without navigation or an unexpected context change. |
| 3.2.6 Consistent Help | Not Applicable | The component contains no help mechanism. |
| 3.3.1 Error Identification | Not Applicable | End users enter no data; invalid developer inputs fail before rendering with specific exceptions. |
| 3.3.2 Labels or Instructions | Supports | The labeled region provides a heading and concise instruction before its choices. |
| 3.3.7 Redundant Entry | Not Applicable | The component collects no repeated user information. |
| 4.1.2 Name, Role, Value | Supports | Native buttons expose role and name; candidate choices expose state with `aria-pressed`; empty accessible labels are rejected. |

## WCAG 2.2 Level AA

| Criterion | Conformance | Remarks and explanations |
|---|---|---|
| 1.2.4 Captions (Live) | Not Applicable | The component contains no live media. |
| 1.2.5 Audio Description (Prerecorded) | Not Applicable | The component contains no prerecorded video. |
| 1.3.4 Orientation | Supports | CSS imposes no portrait or landscape restriction. |
| 1.3.5 Identify Input Purpose | Not Applicable | The component contains no fields that collect user information. |
| 1.4.3 Contrast (Minimum) | Supports | Default body, detail, state, and control text meet the applicable 4.5:1 threshold. |
| 1.4.4 Resize Text | Supports | Relative font sizing, flexible width, and content-driven height support 200% text resizing without loss of content or action. |
| 1.4.5 Images of Text | Supports | All text is rendered as DOM text. |
| 1.4.10 Reflow | Supports | The single-column layout uses a bounded flexible width and does not require two-dimensional scrolling at 320 CSS pixels. |
| 1.4.11 Non-text Contrast | Supports | Default control boundaries and the 3px focus indicator meet the applicable 3:1 threshold; forced-colors mode retains system outlines. |
| 1.4.12 Text Spacing | Supports | No fixed text container height or clipping prevents user text-spacing overrides. |
| 1.4.13 Content on Hover or Focus | Not Applicable | Hover and focus reveal no additional content. |
| 2.4.5 Multiple Ways | Not Applicable | The component is not a set of web pages. |
| 2.4.6 Headings and Labels | Supports | The region heading and button text describe their topic and purpose. |
| 2.4.7 Focus Visible | Supports | Keyboard focus receives a persistent 3px high-contrast outline with a 3px offset. |
| 2.4.11 Focus Not Obscured (Minimum) | Supports | The component creates no sticky, modal, or overlay content that can obscure its focused controls. |
| 2.5.7 Dragging Movements | Not Applicable | No action requires dragging. |
| 2.5.8 Target Size (Minimum) | Supports | Every interactive control has a minimum height of 44 CSS pixels and full-row width. |
| 3.1.2 Language of Parts | Not Applicable | The package emits no known language change; localized host-provided strings are the host's responsibility. |
| 3.2.3 Consistent Navigation | Not Applicable | The component contains no navigation mechanism. |
| 3.2.4 Consistent Identification | Supports | Candidate and “None of these” controls retain consistent names and behavior across updates. |
| 3.3.3 Error Suggestion | Not Applicable | End users enter no data. Developer validation exceptions identify the invalid contract and required correction. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Not Applicable | The component itself causes no legal or financial transaction and does not delete or submit user data. Callback consequences belong to the host. |
| 3.3.8 Accessible Authentication (Minimum) | Not Applicable | The component provides no authentication. |
| 4.1.3 Status Messages | Supports | The labeled component region uses `aria-live="polite"`; visible selected-state text is announced without moving focus. |

## Additional accessibility and cognitive-design notes

- The API caps the choice set at three.
- Titles must contain 3–7 words and details one sentence of 3–19 meaningful
  words with a concrete number, amount, order/SKU, or date-like value.
- Motion is limited to 120ms color transitions and removed when
  `prefers-reduced-motion` is enabled.
- Selection is never communicated by color alone.
- Host applications remain responsible for document language, zoom/reflow
  regressions introduced by surrounding CSS, callback behavior, and the
  accuracy and clarity of candidate content.
