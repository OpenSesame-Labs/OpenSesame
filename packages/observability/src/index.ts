export {
  REDACTED,
  isSensitiveKey,
  scrubText,
  scrubValue,
} from "@opensesame/log-scrub";
export {
  AgentPayloadRefused,
  forAgent,
  looksLikeCredential,
  registerAgentSecret,
  scrubLocalSecrets,
} from "./agent-payload.js";
export {
  type CreateLoggerOptions,
  LOG_REDACT_PATHS,
  type Logger,
  createLogger,
  redactDeep,
} from "./logger.js";
export {
  SEALED_LINE_PREFIX,
  SealedLogFile,
  UNREADABLE,
  createSealedLogDestination,
  loadLogKey,
  loadOrCreateLogKey,
  logKeyPath,
  openLogLine,
  readSealedTail,
  sealExistingLog,
  sealLogLine,
} from "./sealed-log.js";
