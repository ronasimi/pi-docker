// Stock public factory: no transport fork or installed-package edits.
import { createMcpExtension } from '@earendil-works/pi-coding-agent';
export default function (pi) { return createMcpExtension()(pi); }
