/**
 * Runs INSIDE the sandbox, as the last step before the organism command:
 *   bun seccomp-exec.ts <command> [args...]
 * Installs a seccomp-BPF filter (default deny: any syscall not allowed below kills the process with
 * SIGSYS) on every thread, then execve()s the command, which inherits the filter for its whole tree.
 * Self-contained on purpose (only bun:ffi + libc): it is mounted read-only into the sandbox, and its
 * content is part of the sandbox runner's identity — changing the policy makes old evidence STALE.
 * x86_64 only; the runner refuses to start elsewhere.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

// x86_64 syscall numbers. Ordinary process, memory, file, time, signal and socket work (the network
// namespace already has no route out). Absent on purpose: mount/umount2/pivot_root/chroot, unshare/setns,
// ptrace, process_vm_*, kcmp, bpf, perf_event_open, userfaultfd, keyctl/add_key/request_key, module and
// kexec loading, reboot/swap/acct/quotactl, clock and time setters, *_by_handle_at, fanotify, fsopen & co.
export const ALLOWED: Record<string, number> = {
  read: 0, write: 1, open: 2, close: 3, stat: 4, fstat: 5, lstat: 6, poll: 7, lseek: 8, mmap: 9, mprotect: 10, munmap: 11, brk: 12,
  rt_sigaction: 13, rt_sigprocmask: 14, rt_sigreturn: 15, ioctl: 16, pread64: 17, pwrite64: 18, readv: 19, writev: 20, access: 21,
  pipe: 22, select: 23, sched_yield: 24, mremap: 25, msync: 26, mincore: 27, madvise: 28, shmget: 29, shmat: 30, shmctl: 31,
  dup: 32, dup2: 33, pause: 34, nanosleep: 35, getitimer: 36, alarm: 37, setitimer: 38, getpid: 39, sendfile: 40, socket: 41,
  connect: 42, accept: 43, sendto: 44, recvfrom: 45, sendmsg: 46, recvmsg: 47, shutdown: 48, bind: 49, listen: 50,
  getsockname: 51, getpeername: 52, socketpair: 53, setsockopt: 54, getsockopt: 55, fork: 57, vfork: 58, execve: 59,
  exit: 60, wait4: 61, kill: 62, uname: 63, semget: 64, semop: 65, semctl: 66, shmdt: 67, msgget: 68, msgsnd: 69, msgrcv: 70,
  msgctl: 71, fcntl: 72, flock: 73, fsync: 74, fdatasync: 75, truncate: 76, ftruncate: 77, getdents: 78, getcwd: 79, chdir: 80,
  fchdir: 81, rename: 82, mkdir: 83, rmdir: 84, creat: 85, link: 86, unlink: 87, symlink: 88, readlink: 89, chmod: 90,
  fchmod: 91, chown: 92, fchown: 93, lchown: 94, umask: 95, gettimeofday: 96, getrlimit: 97, getrusage: 98, sysinfo: 99,
  times: 100, getuid: 102, getgid: 104, setuid: 105, setgid: 106, geteuid: 107, getegid: 108, setpgid: 109, getppid: 110,
  getpgrp: 111, setsid: 112, setreuid: 113, setregid: 114, getgroups: 115, setgroups: 116, setresuid: 117, getresuid: 118,
  setresgid: 119, getresgid: 120, getpgid: 121, setfsuid: 122, setfsgid: 123, getsid: 124, capget: 125, capset: 126,
  rt_sigpending: 127, rt_sigtimedwait: 128, rt_sigqueueinfo: 129, rt_sigsuspend: 130, sigaltstack: 131, utime: 132, mknod: 133,
  statfs: 137, fstatfs: 138, getpriority: 140, setpriority: 141, sched_setparam: 142, sched_getparam: 143,
  sched_setscheduler: 144, sched_getscheduler: 145, sched_get_priority_max: 146, sched_get_priority_min: 147,
  sched_rr_get_interval: 148, mlock: 149, munlock: 150, mlockall: 151, munlockall: 152, prctl: 157, arch_prctl: 158,
  setrlimit: 160, sync: 162, gettid: 186, readahead: 187, setxattr: 188, lsetxattr: 189, fsetxattr: 190, getxattr: 191,
  lgetxattr: 192, fgetxattr: 193, listxattr: 194, llistxattr: 195, flistxattr: 196, removexattr: 197, lremovexattr: 198,
  fremovexattr: 199, tkill: 200, time: 201, futex: 202, sched_setaffinity: 203, sched_getaffinity: 204, set_thread_area: 205,
  io_setup: 206, io_destroy: 207, io_getevents: 208, io_submit: 209, io_cancel: 210, get_thread_area: 211, epoll_create: 213,
  getdents64: 217, set_tid_address: 218, restart_syscall: 219, semtimedop: 220, fadvise64: 221, timer_create: 222,
  timer_settime: 223, timer_gettime: 224, timer_getoverrun: 225, timer_delete: 226, clock_gettime: 228, clock_getres: 229,
  clock_nanosleep: 230, exit_group: 231, epoll_wait: 232, epoll_ctl: 233, tgkill: 234, utimes: 235, mq_open: 240,
  mq_unlink: 241, mq_timedsend: 242, mq_timedreceive: 243, mq_notify: 244, mq_getsetattr: 245, waitid: 247, ioprio_set: 251,
  ioprio_get: 252, inotify_init: 253, inotify_add_watch: 254, inotify_rm_watch: 255, openat: 257, mkdirat: 258, mknodat: 259,
  fchownat: 260, futimesat: 261, newfstatat: 262, unlinkat: 263, renameat: 264, linkat: 265, symlinkat: 266, readlinkat: 267,
  fchmodat: 268, faccessat: 269, pselect6: 270, ppoll: 271, set_robust_list: 273, get_robust_list: 274, splice: 275, tee: 276,
  sync_file_range: 277, vmsplice: 278, utimensat: 280, epoll_pwait: 281, signalfd: 282, timerfd_create: 283, eventfd: 284,
  fallocate: 285, timerfd_settime: 286, timerfd_gettime: 287, accept4: 288, signalfd4: 289, eventfd2: 290, epoll_create1: 291,
  dup3: 292, pipe2: 293, inotify_init1: 294, preadv: 295, pwritev: 296, rt_tgsigqueueinfo: 297, recvmmsg: 299, prlimit64: 302,
  syncfs: 306, sendmmsg: 307, getcpu: 309, sched_setattr: 314, sched_getattr: 315, renameat2: 316, seccomp: 317, getrandom: 318,
  memfd_create: 319, execveat: 322, membarrier: 324, mlock2: 325, copy_file_range: 326, preadv2: 327, pwritev2: 328,
  pkey_mprotect: 329, pkey_alloc: 330, pkey_free: 331, statx: 332, io_pgetevents: 333, rseq: 334, pidfd_send_signal: 424,
  pidfd_open: 434, close_range: 436, openat2: 437, faccessat2: 439, epoll_pwait2: 441, futex_waitv: 449, cachestat: 451,
  fchmodat2: 452, map_shadow_stack: 453, futex_wake: 454, futex_wait: 455, futex_requeue: 456,
};

/** Optional features runtimes probe for and fall back from: refused with ENOSYS instead of killing. */
export const UNSUPPORTED: Record<string, number> = { personality: 135, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427, clone3: 435, landlock_create_ruleset: 444 };

/**
 * Privileged calls that tools probe at startup: an unprivileged process gets EPERM from the kernel
 * anyway, so the filter answers the same instead of killing (observed: the native tsc probes fanotify).
 */
export const PERMISSION_DENIED: Record<string, number> = { fanotify_init: 300 };

const CLONE = 56;
/** CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET: threads and processes yes, namespaces no. */
const CLONE_NAMESPACES = 0x7e020000;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const X32_SYSCALL_BIT = 0x40000000;
const ENOSYS = 38;
const EPERM = 1;

const RET_KILL_PROCESS = 0x80000000;
const RET_ALLOW = 0x7fff0000;
const RET_ERRNO = 0x00050000;
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const AND_K = 0x54;
const RET_K = 0x06;
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0 = 16;

type Instruction = [code: number, jt: number, jf: number, k: number];

/** The BPF program, as instructions. Exported for tests; the order and offsets are the policy. */
export function program(): Instruction[] {
  const p: Instruction[] = [
    [LD_W_ABS, 0, 0, OFFSET_ARCH],
    [JEQ_K, 1, 0, AUDIT_ARCH_X86_64],
    [RET_K, 0, 0, RET_KILL_PROCESS],
    [LD_W_ABS, 0, 0, OFFSET_NR],
    [JGE_K, 0, 1, X32_SYSCALL_BIT],
    [RET_K, 0, 0, RET_KILL_PROCESS],
    // clone: allowed unless it asks for a new namespace.
    [JEQ_K, 0, 5, CLONE],
    [LD_W_ABS, 0, 0, OFFSET_ARG0],
    [AND_K, 0, 0, CLONE_NAMESPACES],
    [JEQ_K, 0, 1, 0],
    [RET_K, 0, 0, RET_ALLOW],
    [RET_K, 0, 0, RET_KILL_PROCESS],
  ];
  for (const nr of Object.values(UNSUPPORTED)) p.push([JEQ_K, 0, 1, nr], [RET_K, 0, 0, RET_ERRNO | ENOSYS]);
  for (const nr of Object.values(PERMISSION_DENIED)) p.push([JEQ_K, 0, 1, nr], [RET_K, 0, 0, RET_ERRNO | EPERM]);
  for (const nr of Object.values(ALLOWED)) p.push([JEQ_K, 0, 1, nr], [RET_K, 0, 0, RET_ALLOW]);
  p.push([RET_K, 0, 0, RET_KILL_PROCESS]);
  return p;
}

function run(argv: string[]): never {
  const command = argv[0];
  if (!command) throw new Error("uso: seccomp-exec.ts <comando> [args...]");
  const path = command.includes("/") ? command : Bun.which(command);
  if (!path) {
    console.error(`seccomp-exec: comando não encontrado: ${command}`);
    process.exit(127);
  }
  const libc = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i64 },
    execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const PR_SET_NO_NEW_PRIVS = 38;
  const SYS_SECCOMP = 317;
  const SECCOMP_SET_MODE_FILTER = 1;
  const SECCOMP_FILTER_FLAG_TSYNC = 1;

  const instructions = program();
  const filter = new Uint8Array(instructions.length * 8);
  const view = new DataView(filter.buffer);
  instructions.forEach(([code, jt, jf, k], i) => {
    view.setUint16(i * 8, code, true);
    view.setUint8(i * 8 + 2, jt);
    view.setUint8(i * 8 + 3, jf);
    view.setUint32(i * 8 + 4, k, true);
  });
  const fprog = new Uint8Array(16);
  const fview = new DataView(fprog.buffer);
  fview.setUint16(0, instructions.length, true);
  fview.setBigUint64(8, BigInt(ptr(filter)), true);

  if (libc.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) fail("prctl(PR_SET_NO_NEW_PRIVS) falhou");
  if (libc.symbols.syscall(BigInt(SYS_SECCOMP), BigInt(SECCOMP_SET_MODE_FILTER), BigInt(SECCOMP_FILTER_FLAG_TSYNC), ptr(fprog)) !== 0n) fail("seccomp(SET_MODE_FILTER) falhou");

  const cstring = (s: string): Uint8Array => new TextEncoder().encode(`${s}\0`);
  const keep: Uint8Array[] = [];
  const array = (items: string[]): BigUint64Array => {
    const pointers = new BigUint64Array(items.length + 1);
    items.forEach((item, i) => {
      const bytes = cstring(item);
      keep.push(bytes);
      pointers[i] = BigInt(ptr(bytes));
    });
    return pointers;
  };
  const args = array([command, ...argv.slice(1)]);
  const env = array(Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`));
  const file = cstring(path);
  libc.symbols.execve(ptr(file), ptr(args), ptr(env));
  fail(`execve(${path}) falhou`);
}

function fail(message: string): never {
  console.error(`seccomp-exec: ${message}`);
  process.exit(126);
}

if (import.meta.main) run(process.argv.slice(2));
