// Stock public factory: no transport fork or installed-package edits.
import { createToolSearchExtension } from '@earendil-works/pi-coding-agent';
export default function (pi) { return createToolSearchExtension()(pi); }
