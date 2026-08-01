# Specify the read and search contract

Type: prototype
Status: claimed
Blocked by: 01

## Question

What concrete Claude Code-facing tool contract makes deterministic discovery, bounded hit context, outlines, heading-hierarchy sections, Exact Reads, ordered batch reads, Content Versions, and opaque transport continuation efficient and unambiguous on the observed Vault corpus?

## Comments

A concrete logic prototype is ready for Primary Operator evaluation: [PROTOTYPE — Vault read/search contract](../prototypes/read-search-contract/README.md). Its [contract candidate](../prototypes/read-search-contract/contract.md) proposes `vault_discover`, `vault_read`, and `vault_continue` and records the observed corpus pressures behind them.

Round 2 replaces the illustrative continuation with bounded, real UTF-8 content chunks identified by request index and byte range; it also exercises duplicate paths, repeated continuation calls, byte-for-byte CRLF reconstruction, unavailable snapshots, and composable `all(path + text)` discovery. The README contains the second-round drive sequence and expected evidence.

Round 3 makes each transport page use remaining envelope capacity for the next item's legal UTF-8 prefix, distinguishes never-issued, consumed, and snapshot-unavailable token states in the actual state model, and keeps interactive revision, Content Versions, and token lifecycle state intact when displaying the independent sanity check. The contract now labels `continuation_expired` as a required installed-runtime classification that this clock-free prototype does not claim to verify. The README contains explicit third-round sequences and expected output.

This prototype ticket remains claimed rather than resolved until the Primary Operator drives or reviews the artifact and confirms or corrects the contract behavior.
