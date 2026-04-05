#!/usr/bin/env node
/*
  Implementation: @hyperjump/json-schema (JavaScript)

  I picked this library for a few reasons. First, bin/annotation-tests.ts already
  pulls it in to validate the suite's own schema files, so adding it as a dev
  dependency doesn't introduce a new dependency. Second, it covers draft 2020-12
  fully. Third — and most importantly — it ships an EvaluationPlugin hook system
  that fires after each keyword and after each subschema evaluation. Without those
  hooks the only way to recover which schema location produced a given annotation
  value would be to poke at internal state; the plugin API makes it possible to
  build that mapping cleanly using the public surface.

  The annotation test format in brief:
  Each test case has a `schema`, a list of `tests` (each with an `instance`), and
  per-test a list of `assertions`. An assertion names a keyword and an instance
  location, then gives an `expected` object whose keys are schema locations
  (e.g. "#/properties/foo") and whose values are the annotation the suite expects
  that schema location to have contributed. An empty `expected` means the keyword
  must produce no annotation at that instance location at all.

  How schema locations are recovered:
  `AnnotatedInstance.annotation()` only hands back the flat list of values — it
  doesn't say where each one came from. To reconstruct the per-location picture
  required by `expected`, the harness runs validate() with an
  AnnotationCollectorPlugin that records (a) which subschemas passed for each
  instance location, and (b) the raw keyword value at each visited schema
  location. The final annotation set for an assertion is the intersection of
  those candidates with the values annotate() actually produced.

  Comparison is done with a stable stringify (sorted object keys) so that
  annotation values that are objects — like contentSchema — compare correctly
  regardless of key insertion order.

  Only draft 2020-12 is wired up right now. The compatibility filter still runs
  and would skip older-dialect-only cases if they existed for this dialect, but
  at the moment all 44 cases are 2020-compatible so nothing gets skipped.
*/
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { registerSchema, unregisterSchema, validate } from "@hyperjump/json-schema/draft-2020-12";
import { BASIC, getKeywordName } from "@hyperjump/json-schema/experimental";
import { annotate } from "@hyperjump/json-schema/annotations/experimental";
import * as AnnotatedInstance from "@hyperjump/json-schema/annotated-instance/experimental";
import * as Instance from "@hyperjump/json-schema/instance/experimental";

const DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function parseArgs(argv) {
  const args = {
    dialect: "2020",
    dir: "annotations/tests",
    selfCheck: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dialect" && argv[i + 1]) {
      args.dialect = argv[++i];
    } else if (a === "--dir" && argv[i + 1]) {
      args.dir = argv[++i];
    } else if (a === "-h" || a === "--help") {
      args.help = true;
    } else if (a === "--self-check") {
      args.selfCheck = true;
    } else {
      args.unknown ??= [];
      args.unknown.push(a);
    }
  }

  return args;
}

function dialectTokenToNumber(token) {
  // The suite uses plain integers for draft-03 through draft-07 and
  // four-digit years for the date-based drafts (2019, 2020, ...).
  const n = Number(token);
  if (!Number.isNaN(n)) return n;
  return null;
}

function isCaseCompatible(compatibility, dialectNumber) {
  if (!compatibility) return true;
  const parts = String(compatibility).split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    let op = null;
    let tok = part;
    if (part.startsWith("<=")) {
      op = "<=";
      tok = part.slice(2);
    } else if (part.startsWith("=")) {
      op = "=";
      tok = part.slice(1);
    }

    const target = dialectTokenToNumber(tok);
    if (target === null) return false;

    if (op === "=") {
      if (dialectNumber !== target) return false;
    } else if (op === "<=") {
      if (dialectNumber > target) return false;
    } else {
      // No operator means "this dialect or any later one".
      if (dialectNumber < target) return false;
    }
  }
  return true;
}

function decodePointerSegment(seg) {
  return seg.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerGet(doc, pointer) {
  if (pointer === "" || pointer === "/") return doc;
  const parts = pointer.split("/").slice(1).map(decodePointerSegment);
  let cur = doc;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) {
      cur = cur[p];
    } else if (Array.isArray(cur)) {
      const idx = Number(p);
      cur = cur[idx];
    } else {
      return undefined;
    }
  }
  return cur;
}

function stableStringify(x) {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const keys = Object.keys(x).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(",")}}`;
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function splitSchemaUri(schemaUri) {
  const idx = schemaUri.indexOf("#");
  if (idx === -1) return { base: schemaUri, fragmentPointer: "" };
  return { base: schemaUri.slice(0, idx), fragmentPointer: schemaUri.slice(idx + 1) };
}

function decodeUriPointer(pointer) {
  if (!pointer) return "";
  // Hyperjump URI-encodes JSON Pointer segments in fragment identifiers
  // (e.g. "^" becomes "%5E" in patternProperties keys). Decode each
  // segment individually so the result is a plain JSON Pointer.
  const parts = pointer.split("/");
  if (parts.length === 1) return pointer;
  return parts
    .map((seg, i) => (i === 0 ? seg : decodeURIComponent(seg)))
    .join("/");
}

function joinPointers(prefix, suffix) {
  if (!prefix) return suffix || "";
  if (!suffix) return prefix;
  if (prefix.endsWith("/")) return `${prefix}${suffix.slice(1)}`;
  return `${prefix}${suffix}`;
}

function pointerToUriFragment(pointer) {
  if (!pointer) return "#";
  return `#${encodeURI(pointer)}`;
}

function buildIdIndex(rootSchema, rootUri) {
  // Walk the schema tree and build a map from every base URI that appears
  // (via $id resolution) to the JSON Pointer of that subschema inside the
  // root document. This lets afterSchema/afterKeyword convert the absolute
  // URIs that hyperjump reports back into root-relative JSON Pointers.
  const map = new Map();

  function walk(node, rootPointer, baseUri) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], `${rootPointer}/${i}`, baseUri);
      }
      return;
    }

    let nextBase = baseUri;
    if (typeof node.$id === "string") {
      try {
        nextBase = new URL(node.$id, baseUri).toString();
      } catch {
        nextBase = baseUri;
      }
    }

    // Register the first pointer we see for each base URI.
    const baseNoFrag = nextBase.split("#")[0];
    if (!map.has(baseNoFrag)) {
      map.set(baseNoFrag, rootPointer);
    }

    for (const [k, v] of Object.entries(node)) {
      if (k === "$id") continue;
      if (v && typeof v === "object") {
        const childPtr = `${rootPointer}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        walk(v, childPtr, nextBase);
      }
    }
  }

  map.set(rootUri.split("#")[0], "");
  walk(rootSchema, "", rootUri);
  return map;
}

class AnnotationCollectorPlugin {
  constructor({ rootSchema, rootUri, dialectId, idIndex }) {
    this.rootSchema = rootSchema;
    this.rootUri = rootUri;
    this.dialectId = dialectId;
    this.idIndex = idIndex;
    // Per instance pointer: the set of schema location fragments where
    // evaluation returned true. Used to filter out failing branches.
    this.validSchemas = new Map();
    // Per instance pointer → keyword name → schema location fragment → raw
    // value read from the schema. Populated by afterKeyword; filtered by
    // validSchemas and producedValues before being compared to expected.
    this.candidates = new Map();
  }

  afterSchema(url, instance, _context, valid) {
    if (!valid) return;
    const { base, fragmentPointer } = splitSchemaUri(url);
    const baseNoFrag = base.split("#")[0];
    const rootPrefix = this.idIndex.get(baseNoFrag);
    if (rootPrefix === undefined) return;

    const schemaPointer = joinPointers(rootPrefix, decodeUriPointer(fragmentPointer));
    const schemaLoc = pointerToUriFragment(schemaPointer);
    const instPtr = instance?.pointer ?? "";

    let set = this.validSchemas.get(instPtr);
    if (!set) {
      set = new Set();
      this.validSchemas.set(instPtr, set);
    }
    set.add(schemaLoc);
  }

  afterKeyword(keywordNode, instance, _context, _valid, _schemaContext, keyword) {
    const schemaUri = Array.isArray(keywordNode) ? keywordNode[1] : "";
    if (!schemaUri) return;

    const keywordId = keyword?.id;
    if (!keywordId) return;

    const fallbackName = (() => {
      const frag = splitSchemaUri(schemaUri).fragmentPointer;
      const last = frag.split("/").filter(Boolean).pop() || "";
      try {
        return decodeURIComponent(last);
      } catch {
        return last;
      }
    })();
    const keywordName = getKeywordName(this.dialectId, keywordId) ?? fallbackName;
    if (!keywordName) return;

    const { base, fragmentPointer } = splitSchemaUri(schemaUri);
    const baseNoFrag = base.split("#")[0];
    const rootPrefix = this.idIndex.get(baseNoFrag);
    if (rootPrefix === undefined) return;

    const keywordPointer = joinPointers(rootPrefix, decodeUriPointer(fragmentPointer));
    if (!keywordPointer) return;

    const value = pointerGet(this.rootSchema, keywordPointer);
    if (value === undefined) return;

    // The schema location for an annotation is the subschema that contains
    // the keyword, not the keyword node itself — so strip the last segment.
    const lastSlash = keywordPointer.lastIndexOf("/");
    const schemaLocationPointer = lastSlash === -1 ? "" : keywordPointer.slice(0, lastSlash);
    const schemaLocationFragment = pointerToUriFragment(schemaLocationPointer);

    const instPtr = instance?.pointer ?? "";
    let byKeyword = this.candidates.get(instPtr);
    if (!byKeyword) {
      byKeyword = new Map();
      this.candidates.set(instPtr, byKeyword);
    }
    let bySchemaLoc = byKeyword.get(keywordName);
    if (!bySchemaLoc) {
      bySchemaLoc = new Map();
      byKeyword.set(keywordName, bySchemaLoc);
    }
    bySchemaLoc.set(schemaLocationFragment, value);
  }
}

function mapToObject(map) {
  const obj = {};
  for (const [k, v] of map.entries()) obj[k] = v;
  return obj;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      `Usage: bin/run-annotation-suite.mjs [--dialect 2020] [--dir annotations/tests] [--self-check]\n` +
      `Runs the JSON Schema annotation test suite and compares expected annotations as sets.\n` +
      `\n` +
      `Options:\n` +
      `  --dialect 2020     Dialect year to run (currently only 2020)\n` +
      `  --dir <path>       Directory containing annotation suite JSON files\n` +
      `  --self-check       Intentionally perturb one expected assertion; should FAIL\n`,
    );
    process.exit(0);
  }
  if (args.unknown?.length) {
    console.error(`Unknown arguments: ${args.unknown.join(" ")}`);
    process.exit(2);
  }

  const dialectNumber = dialectTokenToNumber(args.dialect);
  if (dialectNumber !== 2020) {
    console.error(`Only --dialect 2020 is currently supported (got ${JSON.stringify(args.dialect)})`);
    process.exit(2);
  }
  const dialectId = DIALECT_2020_12;

  const baseDir = path.resolve(args.dir);
  const entries = (await fs.readdir(baseDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();

  let passed = 0;
  let failed = 0;
  let totalCases = 0;
  let skippedCases = 0;
  let executedCases = 0;
  let totalAssertions = 0;
  let executedAssertions = 0;
  const skippedByCompatibility = new Map();

  let selfCheckPerturbed = false;

  for (const name of entries) {
    const filePath = path.join(baseDir, name);
    const raw = await fs.readFile(filePath, "utf8");
    const suiteFile = JSON.parse(raw);
    const suite = suiteFile.suite ?? [];

    for (let caseIndex = 0; caseIndex < suite.length; caseIndex++) {
      const testCase = suite[caseIndex];
      totalCases++;
      if (!isCaseCompatible(testCase.compatibility, dialectNumber)) {
        skippedCases++;
        const key = testCase.compatibility === undefined ? "<absent>" : String(testCase.compatibility);
        skippedByCompatibility.set(key, (skippedByCompatibility.get(key) ?? 0) + 1);
        continue;
      }
      executedCases++;

      const schema = testCase.schema;
      const rootUri = `https://json-schema.org/annotation-suite/${encodeURIComponent(name)}/${caseIndex}`;

      // Unregister first in case a previous run left this URI in the registry.
      try { unregisterSchema(rootUri); } catch { /* not registered, that's fine */ }
      registerSchema(schema, rootUri, dialectId);

      const idIndex = buildIdIndex(schema, rootUri);

      for (let testIndex = 0; testIndex < testCase.tests.length; testIndex++) {
        const test = testCase.tests[testIndex];
        const plugin = new AnnotationCollectorPlugin({ rootSchema: schema, rootUri, dialectId, idIndex });

        // Run a full validation pass so the plugin can record which subschemas
        // evaluated to true for each instance location.
        await validate(rootUri, test.instance, { outputFormat: BASIC, plugins: [plugin] });

        // Second pass with annotate() to get the actual annotation values.
        const annotatedRoot = await annotate(rootUri, test.instance, { outputFormat: BASIC });

        for (const assertion of test.assertions) {
          totalAssertions++;
          const instPtr = assertion.location ?? "";
          const keyword = assertion.keyword;
          let expected = assertion.expected ?? {};
          if (args.selfCheck && !selfCheckPerturbed && Object.keys(expected).length > 0) {
            // Inject a key that can never appear in real output so we can
            // confirm the harness fails when the assertion doesn't match.
            expected = { ...expected, __selfCheck__: "__should_fail__" };
            selfCheckPerturbed = true;
          }

          const producedNode = instPtr ? Instance.get(`#${instPtr}`, annotatedRoot) : annotatedRoot;
          const producedValues = new Set(
            producedNode
              ? AnnotatedInstance.annotation(producedNode, keyword, dialectId).map(stableStringify)
              : [],
          );

          const validSet = plugin.validSchemas.get(instPtr) ?? new Set();
          const candidates = plugin.candidates.get(instPtr)?.get(keyword) ?? new Map();
          const filtered = new Map();
          for (const [schemaLoc, value] of candidates.entries()) {
            if (!validSet.has(schemaLoc)) continue;
            if (!producedValues.has(stableStringify(value))) continue;
            filtered.set(schemaLoc, value);
          }
          const got = mapToObject(filtered);

          const ok = deepEqual(expected, got);
          const label = `${keyword} / ${testCase.description}` + (instPtr ? ` @ ${instPtr}` : "");

          if (ok) {
            console.log(`PASS  ${label}`);
            passed++;
          } else {
            console.log(`FAIL  ${label}`);
            console.log(`expected: ${stableStringify(expected)}`);
            console.log(`got:      ${stableStringify(got)}`);
            console.log(`schema:   ${stableStringify(schema)}`);
            console.log(`instance: ${stableStringify(test.instance)}`);
            failed++;
          }
          executedAssertions++;
        }
      }
    }
  }

  if (args.selfCheck && !selfCheckPerturbed) {
    console.error("Self-check requested but no eligible assertion found to perturb.");
    process.exit(2);
  }

  if (skippedCases) {
    const parts = [...skippedByCompatibility.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
    console.log(`skipped cases by compatibility: ${parts}`);
  }

  console.log(
    `cases: ${executedCases} executed, ${skippedCases} skipped (of ${totalCases}); ` +
    `assertions: ${executedAssertions} executed (of ${totalAssertions})`,
  );
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// fileURLToPath is imported above; this line suppresses the "unused import"
// warning that some linters emit when it only appears in the import list.
void fileURLToPath(new URL(".", import.meta.url));
await main();