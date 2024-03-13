# How to upgrade the vendored SQLite
1. [Download](https://www.sqlite.org/download.html) the latest amalgamation
2. Extract the zip archive and replace vendor/sqlite3.c and vendor/sqlite3.h.
3. Comment out the following lines in vendor/sqlite3.c (do a find for `__wasi__`):
```c
#if defined(__wasi__)
# undef SQLITE_WASI
# define SQLITE_WASI 1
# undef SQLITE_OMIT_WAL
# define SQLITE_OMIT_WAL 1/* because it requires shared memory APIs */
# ifndef SQLITE_OMIT_LOAD_EXTENSION
#  define SQLITE_OMIT_LOAD_EXTENSION
# endif
# ifndef SQLITE_THREADSAFE
#  define SQLITE_THREADSAFE 0
# endif
#endif
```
4. Run a build `deno task build` or `deno task build-in-docker`
5. Check the diff of sqlite3.h and look for added / modified #defines.  Make sure that those changes are reflected in [src/dist/sqlite_def.js].  Update [build/sqlite_def.js:20] to fix.

# Future Tasks:
* TODO: Automate removing the the `__wasi__` define
