# JSON-Schema-task-submission

# Annotation Test Harness for @hyperjump/json-schema

This repository contains a test harness for the [JSON Schema Annotation Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite/tree/main/annotations), targeting the [@hyperjump/json-schema](https://github.com/hyperjump-io/json-schema) JavaScript implementation with draft 2020-12 support.

This was written as the qualification task for the GSoC 2026 project: **Add Support for Reporting on the Annotation Test Suite** for [Bowtie](https://github.com/bowtie-json-schema/bowtie).

---

## Background

### Annotations vs Validation

JSON Schema has two distinct modes of operation:

- **Validation** produces a boolean result: an instance is either valid or invalid against a schema.
- **Annotations** produce metadata: keywords like `title`, `description`, `default`, `readOnly`, and `examples` attach values to specific locations in an instance during evaluation. These values are not used for validation but carry semantic information for consumers of the schema (documentation generators, UI frameworks, etc.).

The official JSON Schema Test Suite includes a dedicated annotation test suite under `annotations/tests/`. Unlike the validation suite (where the expected result is a pass/fail), annotation tests specify exactly which schema locations should have contributed which annotation values to which instance locations. This makes the comparison more involved: you need to know not just what values were produced, but where each one came from.

Bowtie currently only supports reporting on validation results. This harness is a step toward understanding what full annotation support requires at the protocol and reporting level.

### Why @hyperjump/json-schema

Three reasons:

1. It already appeared in the JSON Schema Test Suite repository as a dev dependency (used in `bin/annotation-tests.ts` to validate the suite's own schema files), so it does not introduce an entirely new dependency to that project.
2. It has complete draft 2020-12 support, which is the dialect the annotation suite targets.
3. It exposes a public `EvaluationPlugin` hook system (`afterSchema` and `afterKeyword`) that fires during evaluation. This is the key: without these hooks, recovering which schema location produced a given annotation value would require accessing internal library state. The plugin API makes it possible to build that mapping entirely through the public surface of the library.

---

## How the Harness Works

### Test format

Each file in `annotations/tests/` contains a suite of test cases. Each test case has:

- `schema`: the JSON Schema under test
- `compatibility`: an optional field indicating which dialects the test applies to (e.g. `"3"` means draft-03 and later, `"=2020"` means 2020-12 only)
- `tests`: a list of instances to annotate, each with a list of `assertions`

Each assertion specifies:
- `location`: a JSON Pointer to an instance location (e.g. `/foo`)
- `keyword`: the annotating keyword (e.g. `title`, `default`)
- `expected`: an object mapping schema locations (e.g. `#/properties/foo`) to the annotation value that schema location should have contributed

An empty `expected` object asserts that the keyword produced no annotation at that instance location at all.

### What the harness does

For each test case, the harness:

1. Registers the schema with `@hyperjump/json-schema` under a synthetic URI.
2. Runs `validate()` with a custom `AnnotationCollectorPlugin` that records two things during evaluation:
   - Which subschemas evaluated to `true` for each instance location (`afterSchema` hook)
   - The raw keyword value at each visited schema location (`afterKeyword` hook)
3. Runs `annotate()` to get the actual annotation values the library produced.
4. For each assertion, intersects the plugin's candidates with the values `annotate()` actually returned. This gives a map of schema location to annotation value that matches the `expected` format.
5. Compares the result to `expected` using stable stringification (sorted object keys) so that annotation values which are objects compare correctly regardless of key insertion order.
6. Prints `PASS` or `FAIL` per assertion with details on mismatches.

### Compatibility filtering

The harness reads the `compatibility` field of each test case and skips cases that do not apply to the dialect being tested. Currently only `--dialect 2020` (draft 2020-12) is supported. All 44 test cases in the current suite are compatible with 2020-12, so nothing is skipped.

---

## Repository Structure

```
.
├── bin/
│   └── run-annotation-suite.mjs   # The test harness
├── annotations/
│   └── tests/                     # Annotation test files from the official suite
│       ├── applicators.json
│       ├── content.json
│       ├── core.json
│       ├── format.json
│       ├── meta-data.json
│       ├── unevaluated.json
│       └── unknown.json
├── package.json
└── README.md
```

---

## Setup

Node.js 18 or later is required.

```bash
npm install
```

---

## Running the Tests

Run the full annotation suite against draft 2020-12:

```bash
npm test
```

This is equivalent to:

```bash
node bin/run-annotation-suite.mjs --dialect 2020
```

Expected output:

```
PASS  title / `properties`, `patternProperties`, and `additionalProperties` @ /foo
PASS  title / `properties`, `patternProperties`, and `additionalProperties` @ /apple
...
cases: 44 executed, 0 skipped (of 44); assertions: 84 executed (of 84)
84 passed, 0 failed
```

### Self-check mode

To verify that the harness itself correctly catches failures (rather than silently passing everything), run:

```bash
npm run self-check
```

This intentionally corrupts one assertion's `expected` value before comparing. The harness should report exactly 1 failure and exit with a non-zero status code.

```
...
83 passed, 1 failed
```

### CLI options

```
node bin/run-annotation-suite.mjs [options]

Options:
  --dialect 2020     Dialect year to run (currently only 2020-12 is supported)
  --dir <path>       Path to annotation test files (default: annotations/tests)
  --self-check       Perturb one assertion to verify the harness catches failures
  -h, --help         Show help
```

---

## Test Coverage

The annotation test suite covers the following keyword categories:

| File | Keywords Covered |
|---|---|
| `applicators.json` | `properties`, `patternProperties`, `additionalProperties`, `propertyNames`, `prefixItems`, `items`, `contains`, `allOf`, `anyOf`, `oneOf`, `not`, `dependentSchemas`, `if`/`then`/`else` |
| `content.json` | `contentMediaType`, `contentEncoding`, `contentSchema` |
| `core.json` | `$ref`, `$defs`, `$dynamicRef`, `$dynamicAnchor` |
| `format.json` | `format` |
| `meta-data.json` | `title`, `description`, `default`, `deprecated`, `readOnly`, `writeOnly`, `examples` |
| `unevaluated.json` | `unevaluatedProperties`, `unevaluatedItems` |
| `unknown.json` | Unknown/extension keywords (`x-*`) |

---

## Notes

- `node_modules/` is excluded via `.gitignore` and should not be committed.
- The annotation test files in `annotations/tests/` are taken directly from the official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) repository and are subject to its license.
