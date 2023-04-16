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

static sqlite3_io_methods IoMethods = {
	1,
	js_xClose,
	js_xRead,
	js_xWrite,
	js_xTruncate,
	js_xSync,
	js_xFileSize,
	js_xLock,
	js_xUnlock,
	js_xCheckReservedLock,
	js_xFileControl,
	js_xSectorSize,
	js_xDeviceCharacteristics,
	NULL,
	NULL,
	NULL,
	NULL,
	NULL,
	NULL
};

// The only thing we do is set the io_methods for the file_out
int xOpen(sqlite3_vfs* vfs, const char* filename, sqlite3_file* file_out, int flags, int* flags_out) {
	file_out->pMethods = &IoMethods;
	return js_xOpen(vfs, filename, file_out, flags, flags_out);
}

__attribute__((visibility("default"))) sqlite3_vfs* allocate_vfs(const char* zName, int mxPathname) {
	sqlite3_vfs* ret = malloc(sizeof(sqlite3_vfs));
	if (ret == NULL) { return ret; }

	ret->iVersion = 2;
	ret->szOsFile = sizeof(sqlite3_file);
	ret->mxPathname = mxPathname;
	ret->pNext = NULL;
	ret->zName = zName;
	ret->pAppData = NULL;
	ret->xOpen = xOpen;
	ret->xDelete = js_xDelete;
	ret->xAccess = js_xAccess;
	ret->xFullPathname = js_xFullPathname;
	ret->xDlOpen = NULL;
	ret->xDlError = NULL;
	ret->xDlSym = NULL;
	ret->xDlClose = NULL;
	ret->xRandomness = js_xRandomness;
	ret->xSleep = js_xSleep;
	ret->xCurrentTime = NULL;
	ret->xGetLastError = js_xGetLastError;
	ret->xCurrentTimeInt64 = js_xCurrentTimeInt64;

	return ret;
}

int sqlite3_os_init() {
	sqlite3_vfs* mem_vfs = allocate_vfs("mem", 16);
	return sqlite3_vfs_register(mem_vfs, 1);
}
int sqlite3_os_end() {
	return SQLITE_OK;
}

int main() {
	sqlite3_config(SQLITE_CONFIG_LOG, js_log, NULL);

	sqlite3_initialize();
}
