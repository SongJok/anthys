# In-memory artifact renderer

This component generates Markdown, TXT, CSV, JSON, HTML, XLSX, DOCX and PDF with the existing pinned ExcelJS/docx/PDFKit dependencies. It is not integrated with task persistence, provenance, ACL, signed downloads, runtime tools or UI. Its tests do not establish R22/P09 completion or T101 end-to-end acceptance.

```ts
import {renderArtifact} from './src/index.js';
const result = await renderArtifact({
  format: 'xlsx',
  title: 'Quarterly figures',
  paragraphs: ['Reviewed figures, including original Decimal scale.'],
  table: {
    columns: [
      {name: 'Orders', type: 'integer'},
      {name: 'Amount', type: 'decimal'},
    ],
    rows: [['900719925474099312345', '123456789.00100']],
  },
}, {signal});
// result.bytes, format, mime, extension, sha256, inspection
```

`renderArtifact(input: unknown, options?: ArtifactOptions)` strictly validates request keys and takes a defensive primitive snapshot. Allowed request keys are `format`, `title`, `paragraphs`, and optional `table` (`columns`, `rows`). Columns declare `text | boolean | integer | decimal`. Every row has exactly one value per column. Null is allowed for every type. Text requires well-formed Unicode without XML-prohibited ASCII controls. Unknown fields, accessors, sparse arrays and custom object prototypes are rejected. No formula nodes are accepted. No identity, ACL, tenant, task, authorization, provenance, URLs, image, output path or execution fields exist in this request.

Integer numbers must be safe JS integers (negative zero is rejected); arbitrarily large integers use canonical base-10 strings. Decimal values are canonical decimal strings without exponent notation; scale is preserved. Decimal numbers are rejected instead of guessing lost precision. Numeric strings are capped at 128 characters. This layer does not calculate financial values. Boolean and null stay typed in JSON/XLSX. XLSX stores every integer and Decimal as text, including safe JS integers, because Excel's numeric precision is only 15 digits. CSV has no native type/null information: it emits formatted text, and null becomes an empty field. The service should preserve the normalized request schema alongside the output when that distinction matters.

## Format behavior and actual verification

- TXT: inert UTF-8, title and paragraphs followed by labelled table records. Line endings normalize to LF.
- Markdown: escapes raw HTML and Markdown syntax so user text cannot create active links, images or raw tags; UTF-8 round trip is checked. A host Markdown viewer should still apply its normal safe rendering policy.
- CSV: requires a table and empty paragraphs; title is metadata only, explicitly reported as `titleIncluded: false`. Every field is RFC4180 quoted. User fields and headers beginning with formula markers after whitespace/BOM, or beginning with tab/CR/LF, receive a literal apostrophe. The exact escaped CSV is parsed back. Consumers must retain this apostrophe when opening/re-exporting in spreadsheet software.
- JSON: versioned structured document includes typed columns and all rows; it is parsed back. Large integers and Decimals remain strings.
- HTML: fixed markup, all title/paragraph/cell text escaped, no user attributes, links, scripts or resources, restrictive CSP meta. Generated tags and UTF-8 are inspected. Serve this as a download, or retain the same origin isolation and HTTP response policy used for untrusted files.
- XLSX: Document and Data sheets; actual ZIP contents and external relationships checked, then ExcelJS reads every expected cell back and rejects formulas/hyperlinks. No macros, links, user formulas or embedded objects are generated.
- DOCX: bounded ZIP, XML text, explicit page breaks and any embedded font bytes read back. Default Courier New is ASCII only; Unicode without a reviewed font fails with `ARTIFACT_DOCX_FONT_REQUIRED`. A4, 1-inch margins, 10pt text, 14pt or actual-font-derived line spacing, and a conservative 648pt body budget. Default ASCII wraps at 72 characters; an approved font uses measured 420pt-width wrapping, explicit EastAsia/ASCII/complex-script font assignment and actual font embedding. Tabs expand to four spaces. Runtime inspection remains structural pagination, not a visual render of every file: `DOCX_EXPLICIT_BREAKS_NOT_VISUALLY_RENDERED` stays explicit. The synthetic DOCX/PDF visual acceptance fixtures and all nine final page images are recorded under `reports/artifact-rendering-20261019/visual-acceptance`; those samples do not guarantee all viewers or complex scripts.
- PDF: uses PDFKit with fixed margins and explicit measured-width wrapping. Actual classic xref entries, stream lengths, page tree, content text operators and embedded ToUnicode mappings are read back; reconstructed text must exactly match all emitted lines. Page count is checked. No arbitrary URLs, scripts, images or host paths are accepted. Default Courier supports printable ASCII only; other text explicitly fails with `ARTIFACT_PDF_FONT_REQUIRED`.

For Unicode PDF, the trusted host service may provide `options.pdfFont: {bytes: Buffer, sha256: string}` from an independently reviewed TrueType/OpenType font. This is not a user request field or an authorization proof. The renderer verifies the supplied digest, size, SFNT cmap coverage and actual PDF ToUnicode text. It never opens a user-supplied font path. TrueType collections and unsupported cmap layouts fail closed. Font embedding/licensing review belongs to the host. Both PDF and DOCX also reject unsupported or restrictive OS/2 embedding flags; PDF rejects no-subsetting fonts because PDFKit subsets them. DOCX requires installable/editable embedding, not preview-only embedding. These technical checks do not grant a license. Complex bidirectional or shaping layouts that cannot be reconstructed exactly fail rather than returning an apparently verified file. The portable test suite embeds an original miniature font built in memory, including the Chinese character 中; no installed/downloaded fonts are required.

For Unicode DOCX, the host may pass `options.docxFont: ReviewedDocumentFont`, where `ReviewedDocumentFont extends ReviewedPdfFont {family: string}`. Family must match the actual SFNT name table. The renderer verifies cmap coverage, digest/size, embedding flags, measured line width/height and the exact de-obfuscated embedded font bytes. No font paths or ordinary user-request font fields are accepted. MIME values are unchanged. New explicit failures include `ARTIFACT_DOCX_FONT_REQUIRED`, `ARTIFACT_FONT_FAMILY_MISMATCH`, `ARTIFACT_FONT_EMBEDDING_DENIED`, `ARTIFACT_DOCX_FONT_UNVERIFIED`, `ARTIFACT_FONT_METRICS_UNSUPPORTED` and `ARTIFACT_DOCX_GLYPH_TOO_WIDE`.

## Resource and failure contract

Default hard ceilings: 1 MiB normalized input, 16,384 UTF-16 code units per text, 1,000 paragraphs, 1,000 rows, 32 columns, 8 MiB output, 100 pages, 256 ZIP entries, 16 MiB expanded ZIP/PDF streams, compression ratio 1,000, and 8 MiB font bytes. Options can only tighten these ceilings. Input text bytes are accumulated before full serialization. ZIPs are checked before library read-back, including CRC, paths, entry counts and decompression bounds. Font cmap lookup uses bounded table sizes and binary searches over sorted ranges.

`AbortSignal` is checked before validation, before generation, around asynchronous library work and before returning bytes. A synchronous renderer cannot preempt the Node event loop; cancellation observed after that work still rejects instead of returning a partial artifact. Native allocation/CPU isolation remains the caller's worker/job responsibility.

Failures reject with `ArtifactFailure.code`, such as `ARTIFACT_CANCELLED`, `ARTIFACT_PRECISION_DENIED`, `ARTIFACT_INPUT_LIMIT`, `ARTIFACT_OUTPUT_LIMIT`, `ARTIFACT_PAGE_LIMIT`, `ARTIFACT_FONT_GLYPH_MISSING`, or `ARTIFACT_RENDER_FAILED`. Internal library error details and partial files are not returned.

The result's SHA-256 binds this exact buffer. `inspection.contentSha256` hashes the normalized request snapshot; `determinism: 'CONTENT_ONLY'` deliberately makes no promise that pinned DOCX/XLSX/PDF libraries return byte-identical metadata/IDs across runs. Internal inspectors understand only the bounded shapes generated here; they are not general-purpose upload parsers.
