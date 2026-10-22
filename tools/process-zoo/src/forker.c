// forker: builds a small process tree, prints every pid, then sleeps. C because Node cannot fork, setsid or setpgid;
// built on demand by forker.ts with $CC, else /usr/bin/cc, and cached in tools/process-zoo/build/ (the holder's Rust
// tests compile it too). See tools/process-zoo/README.md.
//
// Output, one JSON object per line on stdout (and appended to --log FILE when given):
//   {"forker":"proc","role":"parent|child|middle|grandchild","index":i,"pid":…,"ppid":…,"pgid":…,"sid":…}
//   {"forker":"ready","pids":[…]}                 every process is set up; pids still alive (middles exit)
//   {"forker":"signal","role":…,"pid":…,"signal":"TERM","action":"exit|ignore|report"}
//   {"forker":"reaped","pid":…,"by":…,"code":n|null,"signal":"TERM"|null}
//   {"forker":"lifetime","pid":…}                --sleep elapsed: exits 0
// Only the parent prints the proc lines and the ready line; any process prints its own signal and reaped lines.
//
// --listen PORT (so a test can check that the ports are free after Stop): every process that stays alive listens on
// TCP 127.0.0.1, the parent on PORT, child or grandchild i on PORT + 1 + i, each before the ready line. Loopback only.

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static const char USAGE[] =
    "forker: builds a process tree, prints its pids as JSON lines, then sleeps (tools/process-zoo/README.md)\n"
    "\n"
    "usage: forker [options]\n"
    "  --fork           the parent forks --children children\n"
    "  --double-fork    each child (\"middle\") forks a grandchild and exits at once, orphaning it\n"
    "  --children N     children of the parent (default 1, at most 16)\n"
    "  --setsid         the child (or middle, so the grandchild inherits it) starts a new session\n"
    "  --setpgid        the child (or middle) starts a new process group in the same session\n"
    "  --stubborn       every process reports SIGINT, SIGTERM and SIGHUP but keeps running (only SIGKILL ends it)\n"
    "  --sleep SEC      exit 0 after SEC seconds; 0 = until a signal ends it (default 600, a guard against leaks)\n"
    "  --listen PORT    every process that stays alive listens on 127.0.0.1: the parent on PORT, child or\n"
    "                   grandchild i on PORT + 1 + i\n"
    "  --log FILE       also append every line to FILE\n"
    "  -h, --help       this text\n"
    "\n"
    "SIGINT, SIGTERM and SIGHUP end a process (by that signal) unless --stubborn; SIGUSR1 and SIGUSR2 are only\n"
    "reported. Exit status: 0 after --sleep, 2 for a usage error, 1 if a fork or setsid fails.\n";

#define MAX_CHILDREN 16
#define LINE_MAX_BYTES 512

static int log_fd = -1;
static int stubborn = 0;
static const char *role = "parent";
static int role_index = 0;
static volatile sig_atomic_t pending_sig[NSIG];

static const int HANDLED[] = {SIGHUP, SIGINT, SIGTERM, SIGUSR1, SIGUSR2, SIGALRM, SIGCHLD};
#define N_HANDLED ((int)(sizeof HANDLED / sizeof HANDLED[0]))

static const char *signame(int sig) {
  switch (sig) {
    case SIGHUP: return "HUP";
    case SIGINT: return "INT";
    case SIGQUIT: return "QUIT";
    case SIGKILL: return "KILL";
    case SIGTERM: return "TERM";
    case SIGUSR1: return "USR1";
    case SIGUSR2: return "USR2";
    case SIGALRM: return "ALRM";
    case SIGCHLD: return "CHLD";
    case SIGPIPE: return "PIPE";
    case SIGSEGV: return "SEGV";
    case SIGABRT: return "ABRT";
    default: return "?";
  }
}

/** Write a whole line to fd (retrying short writes); errors are ignored: the terminal may be gone. */
static void write_all(int fd, const char *s, size_t n) {
  while (n > 0) {
    ssize_t w = write(fd, s, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return;
    }
    s += w;
    n -= (size_t)w;
  }
}

static void emit(const char *line) {
  size_t n = strlen(line);
  if (log_fd >= 0) write_all(log_fd, line, n); // the log first: whoever saw stdout may SIGKILL at once
  write_all(STDOUT_FILENO, line, n);
}

static void proc_line(char *buf, size_t size) {
  snprintf(buf, size, "{\"forker\":\"proc\",\"role\":\"%s\",\"index\":%d,\"pid\":%d,\"ppid\":%d,\"pgid\":%d,\"sid\":%d}\n", role,
           role_index, (int)getpid(), (int)getppid(), (int)getpgid(0), (int)getsid(0));
}

static void on_signal(int sig) {
  if (sig > 0 && sig < NSIG) pending_sig[sig] = 1;
}

static void die(const char *what) {
  char buf[LINE_MAX_BYTES];
  snprintf(buf, sizeof buf, "forker: %s: %s\n", what, strerror(errno));
  write_all(STDERR_FILENO, buf, strlen(buf));
  _exit(1);
}

#define LISTEN_BACKLOG 8
#define MAX_PORT 65535

/** Listen on TCP 127.0.0.1:port for the life of the process (the socket is never accepted from, only held). */
static void listen_on(unsigned port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) die("socket");
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0) die("bind --listen");
  if (listen(fd, LISTEN_BACKLOG) < 0) die("listen");
}

/** Reap finished children, reporting each. */
static void reap(void) {
  int status;
  pid_t pid;
  char buf[LINE_MAX_BYTES];
  while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
    if (WIFSIGNALED(status))
      snprintf(buf, sizeof buf, "{\"forker\":\"reaped\",\"pid\":%d,\"by\":%d,\"code\":null,\"signal\":\"%s\"}\n", (int)pid, (int)getpid(),
               signame(WTERMSIG(status)));
    else
      snprintf(buf, sizeof buf, "{\"forker\":\"reaped\",\"pid\":%d,\"by\":%d,\"code\":%d,\"signal\":null}\n", (int)pid, (int)getpid(),
               WEXITSTATUS(status));
    emit(buf);
  }
}

/** Sleep until a signal ends the process (or the lifetime does). Handled signals are blocked except inside sigsuspend. */
static void wait_forever(unsigned sleep_sec) {
  sigset_t none;
  sigemptyset(&none);
  if (sleep_sec > 0) alarm(sleep_sec);
  char buf[LINE_MAX_BYTES];
  for (;;) {
    sigsuspend(&none);
    for (int i = 0; i < N_HANDLED; i++) {
      int sig = HANDLED[i];
      if (!pending_sig[sig]) continue;
      pending_sig[sig] = 0;
      if (sig == SIGCHLD) {
        reap();
        continue;
      }
      if (sig == SIGALRM) {
        snprintf(buf, sizeof buf, "{\"forker\":\"lifetime\",\"pid\":%d}\n", (int)getpid());
        emit(buf);
        _exit(0);
      }
      int fatal = (sig == SIGHUP || sig == SIGINT || sig == SIGTERM) && !stubborn;
      const char *action = sig == SIGUSR1 || sig == SIGUSR2 ? "report" : fatal ? "exit" : "ignore";
      snprintf(buf, sizeof buf, "{\"forker\":\"signal\",\"role\":\"%s\",\"index\":%d,\"pid\":%d,\"signal\":\"%s\",\"action\":\"%s\"}\n", role,
               role_index, (int)getpid(), signame(sig), action);
      emit(buf);
      if (fatal) {
        // die by the signal itself, so the parent (or the holder) sees a signal death
        signal(sig, SIG_DFL);
        sigset_t one;
        sigemptyset(&one);
        sigaddset(&one, sig);
        raise(sig);
        sigprocmask(SIG_UNBLOCK, &one, NULL);
        _exit(128 + sig); // not reached
      }
    }
  }
}

/** A proc line's role: 0 middle, 1 grandchild, 2 child. */
static int role_rank(const char *line) {
  const char *r = strstr(line, "\"role\":\"");
  if (!r) return 2;
  if (!strncmp(r + 8, "middle\"", 7)) return 0;
  if (!strncmp(r + 8, "grandchild\"", 11)) return 1;
  return 2;
}

static int index_of(const char *line) {
  const char *i = strstr(line, "\"index\":");
  return i ? atoi(i + 8) : 0;
}

static int by_index_then_role(const void *a, const void *b) {
  const char *x = *(const char *const *)a, *y = *(const char *const *)b;
  int d = index_of(x) - index_of(y);
  return d != 0 ? d : role_rank(x) - role_rank(y);
}

static int parse_uint(const char *s, unsigned max, unsigned *out) {
  char *end = NULL;
  errno = 0;
  unsigned long v = strtoul(s, &end, 10);
  if (errno != 0 || end == s || *end != '\0' || s[0] == '-' || v > max) return -1;
  *out = (unsigned)v;
  return 0;
}

static void usage_error(const char *msg, const char *arg) {
  fprintf(stderr, "forker: %s%s%s\n(see --help)\n", msg, arg ? " " : "", arg ? arg : "");
  exit(2);
}

int main(int argc, char **argv) {
  int do_fork = 0, double_fork = 0, new_session = 0, new_group = 0;
  unsigned children = 1, sleep_sec = 600, listen_port = 0;
  const char *log_path = NULL;
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (!strcmp(a, "-h") || !strcmp(a, "--help")) {
      fputs(USAGE, stdout);
      return 0;
    } else if (!strcmp(a, "--fork")) do_fork = 1;
    else if (!strcmp(a, "--double-fork")) double_fork = 1;
    else if (!strcmp(a, "--setsid")) new_session = 1;
    else if (!strcmp(a, "--setpgid")) new_group = 1;
    else if (!strcmp(a, "--stubborn")) stubborn = 1;
    else if (!strcmp(a, "--children") || !strcmp(a, "--sleep") || !strcmp(a, "--log") || !strcmp(a, "--listen")) {
      if (i + 1 >= argc) usage_error("missing value for", a);
      const char *v = argv[++i];
      if (!strcmp(a, "--log")) log_path = v;
      else if (!strcmp(a, "--listen")) {
        if (parse_uint(v, MAX_PORT - MAX_CHILDREN, &listen_port) || listen_port < 1) usage_error("--listen must be a port 1…65519, got", v);
      } else if (!strcmp(a, "--children")) {
        if (parse_uint(v, MAX_CHILDREN, &children) || children < 1) usage_error("--children must be 1…16, got", v);
      } else if (parse_uint(v, 1000000, &sleep_sec)) usage_error("--sleep must be 0…1000000 seconds, got", v);
    } else usage_error("unknown option", a);
  }
  if (do_fork && double_fork) usage_error("--fork and --double-fork are exclusive", NULL);
  if (new_session && new_group) usage_error("--setsid and --setpgid are exclusive", NULL);
  if ((new_session || new_group) && !do_fork && !double_fork) usage_error("--setsid and --setpgid need --fork or --double-fork", NULL);
  if (!do_fork && !double_fork) children = 0;

  if (log_path) {
    log_fd = open(log_path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
    if (log_fd < 0) die("open --log");
  }

  // Handlers and the blocked mask are set before forking, so every process inherits them; a signal that arrives during
  // set-up waits until the process sleeps.
  signal(SIGPIPE, SIG_IGN);
  sigset_t block;
  sigemptyset(&block);
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_signal;
  sigemptyset(&sa.sa_mask);
  for (int i = 0; i < N_HANDLED; i++) {
    sigaction(HANDLED[i], &sa, NULL);
    sigaddset(&block, HANDLED[i]);
  }
  sigprocmask(SIG_BLOCK, &block, NULL);

  // Readiness: every descendant writes its proc line into this pipe and closes its end; EOF means all are set up.
  int ready[2];
  if (pipe(ready) < 0) die("pipe");

  char buf[LINE_MAX_BYTES];
  for (unsigned i = 0; i < children; i++) {
    pid_t pid = fork();
    if (pid < 0) die("fork");
    if (pid > 0) continue;
    // child (or middle)
    close(ready[0]);
    role = double_fork ? "middle" : "child";
    role_index = (int)i;
    if (new_session && setsid() < 0) die("setsid");
    if (new_group && setpgid(0, 0) < 0) die("setpgid");
    if (listen_port && !double_fork) listen_on(listen_port + 1 + i);
    proc_line(buf, sizeof buf);
    write_all(ready[1], buf, strlen(buf));
    if (double_fork) {
      pid_t g = fork();
      if (g < 0) die("fork");
      if (g == 0) {
        role = "grandchild";
        if (listen_port) listen_on(listen_port + 1 + i);
        proc_line(buf, sizeof buf);
        write_all(ready[1], buf, strlen(buf));
        close(ready[1]);
        wait_forever(sleep_sec);
      }
      _exit(0); // the middle leaves at once: the grandchild is orphaned
    }
    close(ready[1]);
    wait_forever(sleep_sec);
  }

  close(ready[1]);
  if (listen_port) listen_on(listen_port); // after the forks: no child inherits the parent's listener
  proc_line(buf, sizeof buf);
  emit(buf);
  // collect the descendants' lines until every write end is closed
  char lines[MAX_CHILDREN * 2 * LINE_MAX_BYTES];
  size_t got = 0;
  for (;;) {
    ssize_t r = read(ready[0], lines + got, sizeof lines - 1 - got);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) break;
    got += (size_t)r;
    if (got >= sizeof lines - 1) break;
  }
  close(ready[0]);
  lines[got] = '\0';
  // print them in a stable order (by index, the middle before its grandchild), whatever order they arrived in
  char *sorted[MAX_CHILDREN * 2];
  int n = 0;
  for (char *save = NULL, *l = strtok_r(lines, "\n", &save); l && n < MAX_CHILDREN * 2; l = strtok_r(NULL, "\n", &save)) sorted[n++] = l;
  qsort(sorted, (size_t)n, sizeof sorted[0], by_index_then_role);
  for (int i = 0; i < n; i++) {
    snprintf(buf, sizeof buf, "%s\n", sorted[i]);
    emit(buf);
  }

  // the ready line: every pid still running (middles have exited)
  char pids[MAX_CHILDREN * 2 * 16 + 32];
  size_t used = (size_t)snprintf(pids, sizeof pids, "%d", (int)getpid());
  for (int i = 0; i < n; i++) {
    char *pidp = strstr(sorted[i], "\"pid\":");
    if (!pidp || role_rank(sorted[i]) == 0) continue; // middles have exited
    used += (size_t)snprintf(pids + used, sizeof pids - used, ",%d", atoi(pidp + 6));
  }
  snprintf(buf, sizeof buf, "{\"forker\":\"ready\",\"pids\":[%s]}\n", pids);
  emit(buf);
  wait_forever(sleep_sec);
  return 0;
}
