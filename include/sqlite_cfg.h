// Remove Deprecated stuff:
#define SQLITE_DQS 0
#define SQLITE_LIKE_DOESNT_MATCH_BLOBS
#define SQLITE_OMIT_DEPRECATED
#define SQLITE_OMIT_SHARED_CACHE

#define SQLITE_DEFAULT_FOREIGN_KEYS 1
#define SQLITE_ENABLE_DBSTAT_VTAB
#define SQLITE_ENABLE_ATOMIC_WRITE
#define SQLITE_ENABLE_BATCH_ATOMIC_WRITE
#define SQLITE_ENABLE_BYTECODE_VTAB
#define SQLITE_ENABLE_DBPAGE_VTAB
// #define SQLITE_ENABLE_OFFSET_SQL_FUNC

// We use Asyncify coroutines, so need threadsafe:
#define SQLITE_THREADSAFE 0

// #define SQLITE_DEFAULT_WAL_SYNCHRONOUS 1
// #define SQLITE_MAX_EXPR_DEPTH 0
// #define SQLITE_OMIT_DECLTYPE
// #define SQLITE_OMIT_PROGRESS_CALLBACK
// #define SQLITE_USE_ALLOCA
// #define SQLITE_OMIT_AUTOINIT
// #define SQLITE_OMIT_COMPILEOPTION_DIAGS

// Omit things that won't work with wasm (yet)
#define SQLITE_OMIT_LOAD_EXTENSION
#define SQLITE_OMIT_WAL 1
// Disable default VFSs.  Even though we compile with WASI, we don't actually want to use any of the wasi imports:
#define SQLITE_OS_OTHER 1

// Enable URI pathnames (since VFSs may want to take advantage of this)
#define SQLITE_USE_URI 1
#define SQLITE_ALLOW_URI_AUTHORITY

// Enable extra features:
#define SQLITE_ENABLE_NORMALIZE
#define SQLITE_DEFAULT_MEMSTATUS 1

// Enable amalgamation extensions:
#define SQLITE_ENABLE_FTS5
#define SQLITE_ENABLE_MATH_FUNCTIONS
#define SQLITE_JSON1
#define SQLITE_ENABLE_GEOPOLY
#define SQLITE_ENABLE_DBSTAT
#define SQLITE_ENABLE_RTREE 1

__attribute__((import_name("sqlite3_os_init"))) int sqlite3_os_init(void);
__attribute__((import_name("sqlite3_os_end"))) int sqlite3_os_end(void);
