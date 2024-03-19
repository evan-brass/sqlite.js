# How to upgrade the vendored SQLite
1. [Download](https://www.sqlite.org/download.html) the latest amalgamation
2. Extract the zip archive and replace `vendor/sqlite3.c` and `vendor/sqlite3.h`.
4. Recompile by running `deno task compile`
5. Check the diff of sqlite3.h and look for added / modified #defines.  Make sure that those changes are reflected in [src/dist/sqlite_def.js].  Update [build/Makefile] to fix.
