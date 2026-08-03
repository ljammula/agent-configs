---
name: kafka-processing
description: Kafka producer, consumer, stream, retry, and delivery-semantics work. Use only when a Kafka client dependency or Kafka configuration is present. Do not claim end-to-end exactly-once across an external database from Kafka transactions alone.
---

# Kafka processing

State the delivery contract: at-most-once, at-least-once with idempotency, or Kafka-scoped exactly-once.

Test duplicate delivery, crash before and after offset commit, retry exhaustion, rebalance, poison records, ordering assumptions, and producer fencing when applicable. Verify external side effects are idempotent when the contract requires it.
