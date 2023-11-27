#include <stdlib.h>
#include <string.h>
#include "sqlite3.h"

__attribute__((import_name("log"))) void js_log(void*, int, const char*);
__attribute__((import_module("vfs"), import_name("xOpen"))) int js_xOpen(sqlite3_vfs*, const char*, sqlite3_file*, int, int*);
__attribute__((import_module("vfs"), import_name("xDelete"))) int js_xDelete(sqlite3_vfs*, const char*, int);
__attribute__((import_module("vfs"), import_name("xAccess"))) int js_xAccess(sqlite3_vfs*, const char*, int, int*);
__attribute__((import_module("vfs"), import_name("xFullPathname"))) int js_xFullPathname(sqlite3_vfs*, const char*, int, char*);
__attribute__((import_module("vfs"), import_name("xRandomness"))) int js_xRandomness(sqlite3_vfs*, int, char*);
__attribute__((import_module("vfs"), import_name("xSleep"))) int js_xSleep(sqlite3_vfs*, int);
__attribute__((import_module("vfs"), import_name("xGetLastError"))) int js_xGetLastError(sqlite3_vfs*, int, char*);
__attribute__((import_module("vfs"), import_name("xCurrentTimeInt64"))) int js_xCurrentTimeInt64(sqlite3_vfs*, sqlite3_int64*);
__attribute__((import_module("vfs"), import_name("xClose"))) int js_xClose(sqlite3_file*);
__attribute__((import_module("vfs"), import_name("xRead"))) int js_xRead(sqlite3_file*, void*, int, sqlite3_int64);
__attribute__((import_module("vfs"), import_name("xWrite"))) int js_xWrite(sqlite3_file*, const void*, int, sqlite3_int64);
__attribute__((import_module("vfs"), import_name("xTruncate"))) int js_xTruncate(sqlite3_file*, sqlite3_int64);
__attribute__((import_module("vfs"), import_name("xSync"))) int js_xSync(sqlite3_file*, int);
__attribute__((import_module("vfs"), import_name("xFileSize"))) int js_xFileSize(sqlite3_file*, sqlite3_int64*);
__attribute__((import_module("vfs"), import_name("xLock"))) int js_xLock(sqlite3_file*, int);
__attribute__((import_module("vfs"), import_name("xUnlock"))) int js_xUnlock(sqlite3_file*, int);
__attribute__((import_module("vfs"), import_name("xCheckReservedLock"))) int js_xCheckReservedLock(sqlite3_file*, int*);
__attribute__((import_module("vfs"), import_name("xFileControl"))) int js_xFileControl(sqlite3_file*, int, void*);
__attribute__((import_module("vfs"), import_name("xSectorSize"))) int js_xSectorSize(sqlite3_file*);
__attribute__((import_module("vfs"), import_name("xDeviceCharacteristics"))) int js_xDeviceCharacteristics(sqlite3_file*);
__attribute__((import_module("func"), import_name("xFunc"))) void js_xFunc(sqlite3_context*, int, sqlite3_value**);
__attribute__((import_module("func"), import_name("xStep"))) void js_xStep(sqlite3_context*, int, sqlite3_value**);
__attribute__((import_module("func"), import_name("xFinal"))) void js_xFinal(sqlite3_context*);
__attribute__((import_module("func"), import_name("xValue"))) void js_xValue(sqlite3_context*);
__attribute__((import_module("func"), import_name("xInverse"))) void js_xInverse(sqlite3_context*, int, sqlite3_value**);
__attribute__((import_module("func"), import_name("xDestroy"))) void js_xDestroy(void*);
__attribute__((import_module("value"), import_name("release"))) void js_release(void*);

// Pointer Values:
__attribute__((visibility("default"))) int bind_pointer(sqlite3_stmt* stmt, int i, void* ptr) {
	return sqlite3_bind_pointer(stmt, i, ptr, "js", &js_release);
}
__attribute__((visibility("default"))) void result_pointer(sqlite3_context* ctx, void* ptr) {
	return sqlite3_result_pointer(ctx, ptr, "js", &js_release);
}
__attribute__((visibility("default"))) void* value_pointer(sqlite3_value* value) {
	return sqlite3_value_pointer(value, "js");
}

static sqlite3_io_methods IoMethods = {
	.iVersion = 1,
	.xClose = js_xClose,
	.xRead = js_xRead,
	.xWrite = js_xWrite,
	.xTruncate = js_xTruncate,
	.xSync = js_xSync,
	.xFileSize = js_xFileSize,
	.xLock = js_xLock,
	.xUnlock = js_xUnlock,
	.xCheckReservedLock = js_xCheckReservedLock,
	.xFileControl = js_xFileControl,
	.xSectorSize = js_xSectorSize,
	.xDeviceCharacteristics = js_xDeviceCharacteristics
};

// The only thing we do is set the io_methods for the file_out
int xOpen(sqlite3_vfs* vfs, const char* filename, sqlite3_file* file_out, int flags, int* flags_out) {
	file_out->pMethods = &IoMethods;
	return js_xOpen(vfs, filename, file_out, flags, flags_out);
}

// The sqlite3_vfs is always the same except for [mxPathname, zName, and pNext]
static sqlite3_vfs base_vfs = {
	.iVersion = 2,
	.szOsFile = sizeof(sqlite3_file),
	.mxPathname = 128,
	.zName = "mem",
	.xOpen = xOpen,
	.xDelete = js_xDelete,
	.xAccess = js_xAccess,
	.xFullPathname = js_xFullPathname,
	.xRandomness = js_xRandomness,
	.xSleep = js_xSleep,
	.xGetLastError = js_xGetLastError,
	.xCurrentTimeInt64 = js_xCurrentTimeInt64
};

__attribute__((visibility("default"))) sqlite3_vfs* allocate_vfs(const char* zName, int mxPathname) {
	sqlite3_vfs* ret = malloc(sizeof(sqlite3_vfs));
	if (ret == NULL) { return ret; }
	memcpy(ret, &base_vfs, sizeof(sqlite3_vfs));
	
	ret->mxPathname = mxPathname;
	ret->pNext = NULL;
	ret->zName = zName;

	return ret;
}

__attribute__((visibility("default"))) int create_scalar_function(sqlite3* db, const char* name, void* pApp, int nArgs, int flags) {
	return sqlite3_create_function_v2(
		db,
		name,
		nArgs,
		SQLITE_UTF8 | flags,
		pApp,
		js_xFunc,
		NULL,
		NULL,
		js_xDestroy
	);
}

int sqlite3_os_init() {
	return sqlite3_vfs_register(&base_vfs, 1);
}
int sqlite3_os_end() {
	return SQLITE_OK;
}

int main() {
	sqlite3_config(SQLITE_CONFIG_LOG, js_log, NULL);

	sqlite3_initialize();
}

__attribute__((visibility("default"))) void* free_ptr() {
	return &free;
}
