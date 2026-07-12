# facult 2.22.1 upgrade fixture

These files were normalized from a disposable-home run of the published
`facult@2.22.1` package. That npm release identifies Git commit
`ac74820bc06e77733aa856fd92b1463fb4b0b97a`, shasum
`8f0dcd13ffb5f8b7d49583d455bb5239e14d135f`, and integrity
`sha512-Fkhoj/zi/4NlrtulEcGEWsDmmc94MJE2IDsKEgTjd7UQpHRWfvONqwp4LFCvGAoQcFePiIiwPR8aNT4lIz4WEQ==`.

Original destinations:

- `managed.json`: `~/Library/Application Support/fclt/global/managed.json`
- `autosync.json`: `~/Library/Application Support/fclt/global/autosync/services/all.json`
- `autosync.plist`: `~/Library/LaunchAgents/com.fclt.autosync.plist`

The producing run initialized the global operating model in a disposable
`HOME`, managed Codex there, and installed the global autosync service with Git
disabled behind an isolated `launchctl` harness. The fixture replaces the home
and canonical root with `__HOME_DIR__` and `__ROOT_DIR__`; it also normalizes the
machine hostname/source and managed timestamp and preserves the emitted JSON
and plist field shapes. No real user state is captured here.
