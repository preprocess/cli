import {
  booleanValue,
  digest,
  environmentValue,
  exactKeys,
  identifier,
  integerValue,
  nullableTimestamp,
  pageValue,
  record,
  stringValue,
  timestamp,
  typeId,
} from "./validate.js";

export function validateMe(value: unknown): Readonly<Record<string, unknown>> {
  const me = record(value, "identity");
  exactKeys(
    me,
    ["principal", "organization", "workspace", "environment", "capabilities"],
    [],
    "identity",
  );
  const principal = record(me.principal, "principal");
  exactKeys(
    principal,
    ["kind", "id"],
    ["role", "permissions"],
    "principal",
  );
  if (!["user", "api_key", "m2m"].includes(String(principal.kind)))
    throw new Error("The API returned an invalid principal.");
  const capabilities = me.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.some(
      (item) => typeof item !== "string" || item.length > 128,
    )
  )
    throw new Error("The API returned invalid capabilities.");
  return {
    principal: {
      kind: principal.kind,
      id: stringValue(principal.id, "principal identifier", 256),
      ...(principal.role === undefined
        ? {}
        : { role: stringValue(principal.role, "principal role", 64) }),
      ...(principal.permissions === undefined
        ? {}
        : {
            permissions: stringArray(
              principal.permissions,
              "principal permissions",
            ),
          }),
    },
    organization: identityResource(
      me.organization,
      "organization",
      ["id", "name"],
    ),
    workspace: identityResource(
      me.workspace,
      "workspace",
      ["id", "name", "slug"],
    ),
    environment: environmentValue(me.environment),
    capabilities: stringArray(capabilities, "capabilities"),
  };
}

function boundedRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  const result = record(value, label);
  if (Object.keys(result).length > 32)
    throw new Error(`The API returned an invalid ${label}.`);
  return result;
}

function identityResource(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  const result = record(value, label);
  if (
    !Object.hasOwn(result, "id") ||
    Object.keys(result).some((key) => !allowed.includes(key))
  )
    throw new Error(`The API returned an incompatible ${label}.`);
  const sanitized: Record<string, unknown> = {
    id: stringValue(result.id, `${label} identifier`, 256),
  };
  for (const key of allowed) {
    if (key !== "id" && result[key] !== undefined)
      sanitized[key] = stringValue(result[key], `${label} ${key}`, 255);
  }
  return sanitized;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 512 ||
    value.some(
      (item) =>
        typeof item !== "string" || item.length < 1 || item.length > 128,
    )
  )
    throw new Error(`The API returned invalid ${label}.`);
  return value as string[];
}

export function validateProcessVersion(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const version = record(value, "Process version");
  exactKeys(
    version,
    [
      "id",
      "processId",
      "version",
      "contentDigest",
      "manifestDigest",
      "manifest",
      "packageBytes",
      "manifestBytes",
      "source",
      "sdkVersion",
      "compilerVersion",
      "formatVersion",
      "capabilities",
      "testSummary",
      "wfpScriptName",
      "state",
      "publishedAt",
      "createdAt",
    ],
    [],
    "Process version",
  );
  if (version.formatVersion !== "preprocess.package/v1")
    throw new Error("The API returned an incompatible package format.");
  if (!["building", "published", "retired"].includes(String(version.state)))
    throw new Error("The API returned an invalid Process version state.");
  const source = record(version.source, "Process source");
  exactKeys(source, ["kind", "commitSha", "dirty"], [], "Process source");
  if (source.commitSha !== null)
    stringValue(source.commitSha, "source commit", 128);
  booleanValue(source.dirty, "source dirty state");
  boundedRecord(version.manifest, "manifest");
  boundedRecord(version.capabilities, "capabilities");
  boundedRecord(version.testSummary, "test summary");
  return {
    id: typeId(version.id, "procv"),
    processId: typeId(version.processId, "proc"),
    version: stringValue(version.version, "version", 128),
    contentDigest: digest(version.contentDigest, "content digest"),
    manifestDigest: digest(version.manifestDigest, "manifest digest"),
    manifest: version.manifest,
    packageBytes: integerValue(version.packageBytes, "package bytes", 1),
    manifestBytes: integerValue(version.manifestBytes, "manifest bytes", 1),
    source,
    sdkVersion: stringValue(version.sdkVersion, "SDK version", 128),
    compilerVersion: stringValue(
      version.compilerVersion,
      "compiler version",
      128,
    ),
    formatVersion: version.formatVersion,
    capabilities: version.capabilities,
    testSummary: version.testSummary,
    wfpScriptName: stringValue(
      version.wfpScriptName,
      "script name",
      255,
    ),
    state: version.state,
    publishedAt: nullableTimestamp(version.publishedAt, "published time"),
    createdAt: timestamp(version.createdAt, "created time"),
  };
}

export function validateHostedRun(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const run = record(value, "hosted run");
  exactKeys(
    run,
    [
      "id",
      "processId",
      "processVersionId",
      "environment",
      "status",
      "createdAt",
    ],
    [],
    "hosted run",
  );
  return {
    id: identifier(run.id, "run identifier"),
    processId: typeId(run.processId, "proc"),
    processVersionId: typeId(run.processVersionId, "procv"),
    environment: environmentValue(run.environment),
    status: stringValue(run.status, "run status", 64),
    createdAt: timestamp(run.createdAt, "run creation time"),
  };
}

function validateExecutionIdentity(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const identity = record(value, "execution identity");
  exactKeys(
    identity,
    [
      "id",
      "caseId",
      "caseRevision",
      "generation",
      "caseSequence",
      "status",
      "createdAt",
      "terminalAt",
    ],
    [],
    "execution identity",
  );
  if (
    !["current", "superseded", "completed", "cancelled"].includes(
      String(identity.status),
    )
  )
    throw new Error("The API returned an invalid execution status.");
  return {
    id: identifier(identity.id, "execution identifier"),
    caseId: typeId(identity.caseId, "case"),
    caseRevision: integerValue(identity.caseRevision, "case revision", 1),
    generation: integerValue(identity.generation, "generation", 1),
    caseSequence: integerValue(identity.caseSequence, "case sequence", 1),
    status: identity.status,
    createdAt: timestamp(identity.createdAt, "execution creation time"),
    terminalAt: nullableTimestamp(identity.terminalAt, "execution terminal time"),
  };
}

export function validateExecutionPage(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return pageValue(value, (item) => {
    const result = record(item, "execution list item");
    exactKeys(result, ["identity"], [], "execution list item");
    return { identity: validateExecutionIdentity(result.identity) };
  });
}

export function validateExecutionDetail(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const detail = record(value, "execution detail");
  const collectionKeys = [
    "supervisor",
    "waits",
    "agents",
    "workItems",
    "effects",
    "interventions",
    "schemas",
    "workspace",
    "memory",
    "patches",
  ] as const;
  exactKeys(
    detail,
    ["identity", "scope", ...collectionKeys],
    [],
    "execution detail",
  );
  const scope = record(detail.scope, "execution scope");
  exactKeys(
    scope,
    [
      "workspaceId",
      "processId",
      "processVersionId",
      "caseStatus",
      "throughSequence",
    ],
    [],
    "execution scope",
  );
  for (const key of collectionKeys)
    boundedArray(detail[key], "execution detail collection", 600);
  return {
    identity: validateExecutionIdentity(detail.identity),
    scope: {
      workspaceId: typeId(scope.workspaceId, "ws"),
      processId: typeId(scope.processId, "proc"),
      processVersionId: typeId(scope.processVersionId, "procv"),
      caseStatus: stringValue(scope.caseStatus, "case status", 64),
      throughSequence: integerValue(
        scope.throughSequence,
        "through sequence",
        1,
      ),
    },
    supervisor: boundedArray(detail.supervisor, "supervisor records", 200).map(
      validateSupervisor,
    ),
    waits: boundedArray(detail.waits, "wait records", 200).map(validateWait),
    agents: boundedArray(detail.agents, "agent records", 600).map(validateAgent),
    workItems: boundedArray(detail.workItems, "work item records", 200).map(
      validateWorkItem,
    ),
    effects: boundedArray(detail.effects, "effect records", 200).map(
      validateEffect,
    ),
    interventions: boundedArray(
      detail.interventions,
      "intervention records",
      200,
    ).map(validateIntervention),
    schemas: boundedArray(detail.schemas, "schema records", 200).map(
      validateSchema,
    ),
    workspace: boundedArray(detail.workspace, "workspace records", 200).map(
      validateWorkspace,
    ),
    memory: boundedArray(detail.memory, "memory records", 200).map(
      validateMemory,
    ),
    patches: boundedArray(detail.patches, "patch records", 200).map(
      validatePatch,
    ),
  };
}

export function validateExecutionLogs(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const logs = record(value, "execution logs");
  exactKeys(
    logs,
    [
      "taxonomyVersion",
      "executionId",
      "caseId",
      "revision",
      "classification",
      "throughSequence",
      "data",
      "nextCursor",
      "hasMore",
    ],
    [],
    "execution logs",
  );
  if (logs.taxonomyVersion !== "1")
    throw new Error("The API returned incompatible execution logs.");
  if (logs.classification !== "standard" && logs.classification !== "sensitive")
    throw new Error("The API returned an invalid log classification.");
  if (!Array.isArray(logs.data) || logs.data.length > 250)
    throw new Error("The API returned invalid execution logs.");
  const data = logs.data.map((item) => {
    const event = record(item, "execution log event");
    exactKeys(
      event,
      [
        "schemaVersion",
        "sequence",
        "source",
        "eventType",
        "sourceId",
        "attempt",
        "correlationId",
        "status",
        "classification",
        "occurredAt",
        "terminalAt",
        "messageCode",
        "messageTemplate",
        "redaction",
        "evidence",
      ],
      [],
      "execution log event",
    );
    if (
      event.schemaVersion !== "1" ||
      event.messageTemplate !== "Recorded canonical execution state."
    )
      throw new Error("The API returned incompatible execution logs.");
    const sources = [
      "case_runtime",
      "think",
      "subagent",
      "schema",
      "tool",
      "customer_code",
      "egress",
      "sandbox",
      "context",
    ];
    if (!sources.includes(String(event.source)))
      throw new Error("The API returned an invalid execution log source.");
    const classification = classificationValue(event.classification);
    const redaction = record(event.redaction, "log redaction");
    exactKeys(redaction, ["applied", "fields"], [], "log redaction");
    const fields = boundedArray(redaction.fields, "redaction fields", 2).map(
      (field) => {
        if (field !== "message" && field !== "payload")
          throw new Error("The API returned invalid redaction fields.");
        return field;
      },
    );
    const evidence = boundedArray(event.evidence, "log evidence", 1);
    if (evidence.length !== 1)
      throw new Error("The API returned invalid log evidence.");
    const evidenceRecord = record(evidence[0], "log evidence");
    exactKeys(evidenceRecord, ["kind", "id"], ["digest"], "log evidence");
    if (evidenceRecord.kind !== "canonical_record")
      throw new Error("The API returned invalid log evidence.");
    return {
      schemaVersion: "1",
      sequence: integerValue(event.sequence, "log sequence", 1),
      source: event.source,
      eventType: boundedCode(event.eventType, "event type", 128, true),
      sourceId: identifier(event.sourceId, "event source identifier"),
      attempt: integerValue(event.attempt, "event attempt", 0),
      correlationId: identifier(
        event.correlationId,
        "event correlation identifier",
      ),
      status: boundedStatus(event.status),
      classification,
      occurredAt: timestamp(event.occurredAt, "event occurrence time"),
      terminalAt: nullableTimestamp(event.terminalAt, "event terminal time"),
      messageCode: boundedCode(event.messageCode, "message code", 160, true),
      messageTemplate: "Recorded canonical execution state.",
      redaction: {
        applied: booleanValue(redaction.applied, "redaction state"),
        fields,
      },
      evidence: [
        {
          kind: "canonical_record",
          id: identifier(evidenceRecord.id, "evidence identifier"),
          ...(evidenceRecord.digest === undefined
            ? {}
            : { digest: digest(evidenceRecord.digest, "evidence digest") }),
        },
      ],
    };
  });
  return {
    taxonomyVersion: "1",
    executionId: identifier(logs.executionId, "execution identifier"),
    caseId: typeId(logs.caseId, "case"),
    revision: integerValue(logs.revision, "case revision", 1),
    classification: logs.classification,
    throughSequence: integerValue(
      logs.throughSequence,
      "through sequence",
      1,
    ),
    data,
    nextCursor:
      logs.nextCursor === null
        ? null
        : stringValue(logs.nextCursor, "next cursor", 2048),
    hasMore: booleanValue(logs.hasMore, "hasMore"),
  };
}

function validateActivation(value: unknown): Readonly<Record<string, unknown>> {
  const activation = record(value, "activation");
  exactKeys(
    activation,
    [
      "processId",
      "environment",
      "activeVersionId",
      "previousVersionId",
      "bindingDigest",
      "updatedAt",
    ],
    [],
    "activation",
  );
  return {
    processId: typeId(activation.processId, "proc"),
    environment: environmentValue(activation.environment),
    activeVersionId: typeId(activation.activeVersionId, "procv"),
    previousVersionId:
      activation.previousVersionId === null
        ? null
        : typeId(activation.previousVersionId, "procv"),
    bindingDigest: digest(activation.bindingDigest, "binding digest"),
    updatedAt: timestamp(activation.updatedAt, "activation time"),
  };
}

export function validatePromotion(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const promotion = record(value, "promotion");
  exactKeys(promotion, ["deployment", "activation"], [], "promotion");
  const deployment = record(promotion.deployment, "deployment");
  exactKeys(
    deployment,
    [
      "processId",
      "processVersionId",
      "environment",
      "contentDigest",
      "scriptName",
      "capabilityDigest",
      "bindingDigest",
      "state",
      "deploymentRef",
      "errorCode",
      "deployedAt",
    ],
    [],
    "deployment",
  );
  if (
    !["deploying", "deployed", "ambiguous", "failed"].includes(
      String(deployment.state),
    )
  )
    throw new Error("The API returned an invalid deployment state.");
  return {
    deployment: {
      processId: typeId(deployment.processId, "proc"),
      processVersionId: typeId(deployment.processVersionId, "procv"),
      environment: environmentValue(deployment.environment),
      contentDigest: digest(deployment.contentDigest, "content digest"),
      scriptName: stringValue(deployment.scriptName, "script name", 128),
      capabilityDigest: digest(
        deployment.capabilityDigest,
        "capability digest",
      ),
      bindingDigest: digest(deployment.bindingDigest, "binding digest"),
      state: deployment.state,
      deploymentRef:
        deployment.deploymentRef === null
          ? null
          : stringValue(deployment.deploymentRef, "deployment reference", 512),
      errorCode:
        deployment.errorCode === null
          ? null
          : stringValue(deployment.errorCode, "deployment error code", 128),
      deployedAt: nullableTimestamp(
        deployment.deployedAt,
        "deployment time",
      ),
    },
    activation: validateActivation(promotion.activation),
  };
}

export function validateRollback(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return validateActivation(value);
}

function boundedArray(
  value: unknown,
  label: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`The API returned invalid ${label}.`);
  return value;
}

function boundedStatus(value: unknown): string {
  return boundedCode(value, "status", 64, false);
}

function boundedCode(
  value: unknown,
  label: string,
  maximum: number,
  dotted: boolean,
): string {
  const result = stringValue(value, label, maximum);
  const pattern = dotted
    ? /^[a-z][a-z0-9_.]{0,159}$/
    : /^[a-z][a-z0-9_]{0,63}$/;
  if (!pattern.test(result))
    throw new Error(`The API returned an invalid ${label}.`);
  return result;
}

function classificationValue(value: unknown): "standard" | "sensitive" {
  if (value !== "standard" && value !== "sensitive")
    throw new Error("The API returned an invalid classification.");
  return value;
}

function validateSummaryBase(
  value: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return {
    id: identifier(value.id, "record identifier"),
    status: boundedStatus(value.status),
    createdAt: timestamp(value.createdAt, "record creation time"),
    terminalAt: nullableTimestamp(value.terminalAt, "record terminal time"),
  };
}

function validateSupervisor(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "supervisor record");
  exactKeys(
    item,
    [
      "id",
      "caseSequence",
      "stateDigest",
      "observedOutboxSequence",
      "processedOutboxSequence",
      "createdAt",
    ],
    [],
    "supervisor record",
  );
  return {
    id: identifier(item.id, "supervisor identifier"),
    caseSequence: integerValue(item.caseSequence, "case sequence", 1),
    stateDigest: digest(item.stateDigest, "state digest"),
    observedOutboxSequence: integerValue(
      item.observedOutboxSequence,
      "observed outbox sequence",
      0,
    ),
    processedOutboxSequence: integerValue(
      item.processedOutboxSequence,
      "processed outbox sequence",
      0,
    ),
    createdAt: timestamp(item.createdAt, "supervisor creation time"),
  };
}

function validateWait(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "wait record");
  exactKeys(
    item,
    [
      "id",
      "generationId",
      "caseSequence",
      "kind",
      "status",
      "openedAt",
      "terminalAt",
    ],
    [],
    "wait record",
  );
  return {
    id: identifier(item.id, "wait identifier"),
    generationId: identifier(item.generationId, "generation identifier"),
    caseSequence: integerValue(item.caseSequence, "case sequence", 1),
    kind: boundedStatus(item.kind),
    status: boundedStatus(item.status),
    openedAt: timestamp(item.openedAt, "wait opening time"),
    terminalAt: nullableTimestamp(item.terminalAt, "wait terminal time"),
  };
}

function validateAgent(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "agent record");
  exactKeys(
    item,
    [
      "kind",
      "id",
      "runId",
      "attempt",
      "status",
      "caseSequence",
      "inputDigest",
      "createdAt",
      "terminalAt",
    ],
    [],
    "agent record",
  );
  if (
    !["submission", "model_attempt", "platform_attempt"].includes(
      String(item.kind),
    )
  )
    throw new Error("The API returned an invalid agent kind.");
  return {
    kind: item.kind,
    id: identifier(item.id, "agent identifier"),
    runId: identifier(item.runId, "agent run identifier"),
    attempt: integerValue(item.attempt, "agent attempt", 1),
    status: boundedStatus(item.status),
    caseSequence: integerValue(item.caseSequence, "case sequence", 1),
    inputDigest: digest(item.inputDigest, "input digest"),
    createdAt: timestamp(item.createdAt, "agent creation time"),
    terminalAt: nullableTimestamp(item.terminalAt, "agent terminal time"),
  };
}

function validateWorkItem(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "work item record");
  exactKeys(
    item,
    [
      "id",
      "status",
      "createdAt",
      "terminalAt",
      "attempt",
      "baseSequence",
      "scopeDigest",
    ],
    [],
    "work item record",
  );
  return {
    ...validateSummaryBase(item),
    attempt: integerValue(item.attempt, "work item attempt", 1),
    baseSequence: integerValue(item.baseSequence, "base sequence", 1),
    scopeDigest: digest(item.scopeDigest, "scope digest"),
  };
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`The API returned an invalid ${label}.`);
  return value;
}

function validateEffect(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "effect record");
  exactKeys(
    item,
    [
      "id",
      "status",
      "createdAt",
      "terminalAt",
      "kind",
      "attempt",
      "caseSequence",
      "classification",
      "usage",
      "resultDigest",
      "errorDigest",
    ],
    [],
    "effect record",
  );
  if (
    !["tool_call", "customer_code_call", "external_request"].includes(
      String(item.kind),
    )
  )
    throw new Error("The API returned an invalid effect kind.");
  if (
    !["standard", "sensitive", "restricted"].includes(
      String(item.classification),
    )
  )
    throw new Error("The API returned an invalid effect classification.");
  let usage: Readonly<Record<string, unknown>> | null = null;
  if (item.usage !== null) {
    const raw = record(item.usage, "effect usage");
    exactKeys(
      raw,
      ["cpuMs", "wallMs", "subrequests", "inputBytes", "outputBytes"],
      [],
      "effect usage",
    );
    usage = {
      cpuMs: nullableNumber(raw.cpuMs, "CPU usage"),
      wallMs: nullableNumber(raw.wallMs, "wall usage"),
      subrequests: nullableNumber(raw.subrequests, "subrequest usage"),
      inputBytes: nullableNumber(raw.inputBytes, "input byte usage"),
      outputBytes: nullableNumber(raw.outputBytes, "output byte usage"),
    };
  }
  return {
    ...validateSummaryBase(item),
    kind: item.kind,
    attempt: integerValue(item.attempt, "effect attempt", 1),
    caseSequence: integerValue(item.caseSequence, "case sequence", 1),
    classification: item.classification,
    usage,
    resultDigest:
      item.resultDigest === null
        ? null
        : digest(item.resultDigest, "result digest"),
    errorDigest:
      item.errorDigest === null ? null : digest(item.errorDigest, "error digest"),
  };
}

function validateIntervention(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const item = record(value, "intervention record");
  exactKeys(
    item,
    [
      "id",
      "status",
      "createdAt",
      "terminalAt",
      "externalRequestId",
      "kind",
      "basisDigest",
    ],
    [],
    "intervention record",
  );
  return {
    ...validateSummaryBase(item),
    externalRequestId: identifier(
      item.externalRequestId,
      "external request identifier",
    ),
    kind: boundedStatus(item.kind),
    basisDigest: digest(item.basisDigest, "basis digest"),
  };
}

function validateSchema(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "schema record");
  exactKeys(
    item,
    [
      "id",
      "caseSequence",
      "processVersionId",
      "shapeDigest",
      "ruleDigest",
      "domainDigest",
      "resultDigest",
      "evaluationDigest",
      "createdAt",
    ],
    [],
    "schema record",
  );
  return {
    id: identifier(item.id, "schema identifier"),
    caseSequence: integerValue(item.caseSequence, "case sequence", 1),
    processVersionId: typeId(item.processVersionId, "procv"),
    shapeDigest: digest(item.shapeDigest, "shape digest"),
    ruleDigest: digest(item.ruleDigest, "rule digest"),
    domainDigest: digest(item.domainDigest, "domain digest"),
    resultDigest: digest(item.resultDigest, "result digest"),
    evaluationDigest: digest(item.evaluationDigest, "evaluation digest"),
    createdAt: timestamp(item.createdAt, "schema creation time"),
  };
}

function validateWorkspace(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "workspace record");
  exactKeys(
    item,
    [
      "id",
      "status",
      "createdAt",
      "terminalAt",
      "kind",
      "workItemId",
      "workItemAttempt",
      "sequence",
      "digest",
    ],
    [],
    "workspace record",
  );
  if (
    !["contract", "run", "checkpoint", "legacy_run", "legacy_checkpoint"].includes(
      String(item.kind),
    )
  )
    throw new Error("The API returned an invalid workspace record kind.");
  return {
    ...validateSummaryBase(item),
    kind: item.kind,
    workItemId: identifier(item.workItemId, "work item identifier"),
    workItemAttempt: integerValue(
      item.workItemAttempt,
      "work item attempt",
      0,
    ),
    sequence: integerValue(item.sequence, "workspace sequence", 0),
    digest: digest(item.digest, "workspace digest"),
  };
}

function validateMemory(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "memory record");
  exactKeys(
    item,
    [
      "id",
      "processVersionId",
      "queryDigest",
      "policyDigest",
      "filterDigest",
      "indexedThroughSequence",
      "createdAt",
    ],
    [],
    "memory record",
  );
  return {
    id: identifier(item.id, "memory identifier"),
    processVersionId: typeId(item.processVersionId, "procv"),
    queryDigest: digest(item.queryDigest, "query digest"),
    policyDigest: digest(item.policyDigest, "policy digest"),
    filterDigest: digest(item.filterDigest, "filter digest"),
    indexedThroughSequence: integerValue(
      item.indexedThroughSequence,
      "indexed sequence",
      0,
    ),
    createdAt: timestamp(item.createdAt, "memory creation time"),
  };
}

function validatePatch(value: unknown): Readonly<Record<string, unknown>> {
  const item = record(value, "patch record");
  exactKeys(
    item,
    [
      "id",
      "status",
      "createdAt",
      "terminalAt",
      "patchId",
      "baseSequence",
      "acceptedSequence",
      "proposalDigest",
      "resultDigest",
      "snapshotId",
    ],
    [],
    "patch record",
  );
  return {
    ...validateSummaryBase(item),
    patchId: identifier(item.patchId, "patch identifier"),
    baseSequence: integerValue(item.baseSequence, "base sequence", 1),
    acceptedSequence:
      item.acceptedSequence === null
        ? null
        : integerValue(item.acceptedSequence, "accepted sequence", 1),
    proposalDigest: digest(item.proposalDigest, "proposal digest"),
    resultDigest:
      item.resultDigest === null
        ? null
        : digest(item.resultDigest, "result digest"),
    snapshotId: identifier(item.snapshotId, "snapshot identifier"),
  };
}
