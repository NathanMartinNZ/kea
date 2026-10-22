// intruder: a same-user process that is not Kea (tests I-HLD-24, I-HLD-29). Built by the tests with
// /usr/bin/cc into their temp dir. On macOS it is not Apple-signed; on arm64 the linker signs it ad hoc, so it has a
// cdhash of its own, which does not satisfy the test runner's designated requirement (`cdhash H"…"` of the
// test binary) that the holders are started with. On Linux it is another executable than the test binary the holders
// are started with (`--client-exe-unchecked`).
//
// usage: intruder <socket> <connections> <hex bytes> <timeout ms>
//
// Opens <connections> connections to <socket> at once, writes <hex bytes> (protocol frames) on each, prints
// "connected <k>" (k = connections that got through; the rest were refused by connect itself), then waits
// for the holder to close each one. Then one line per connection:
//   conn <i> refused-at-connect
//   conn <i> closed <ms from connect to close> <bytes the holder sent>
//   conn <i> open                         (still open after <timeout ms>)
// Exit status 0 when every connection was refused or closed, 1 otherwise, 2 for a usage error.

#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define MAX_CONNECTIONS 256

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: intruder <socket> <connections> <hex bytes> <timeout ms>\n");
    return 2;
  }
  int n = atoi(argv[2]);
  double timeout = atof(argv[4]);
  size_t hexlen = strlen(argv[3]);
  if (n < 1 || n > MAX_CONNECTIONS || hexlen % 2 != 0 || strlen(argv[1]) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
    fprintf(stderr, "intruder: bad arguments\n");
    return 2;
  }
  unsigned char *bytes = malloc(hexlen / 2 + 1);
  for (size_t i = 0; i < hexlen / 2; i++) {
    int hi = hexval(argv[3][2 * i]), lo = hexval(argv[3][2 * i + 1]);
    if (hi < 0 || lo < 0) {
      fprintf(stderr, "intruder: bad hex\n");
      return 2;
    }
    bytes[i] = (unsigned char)(hi * 16 + lo);
  }

  // A write to a connection the holder has already closed is part of being refused, not a reason to die (SIGPIPE).
  signal(SIGPIPE, SIG_IGN);
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  strcpy(addr.sun_path, argv[1]);
  int fds[MAX_CONNECTIONS];
  double opened[MAX_CONNECTIONS], closed_at[MAX_CONNECTIONS];
  long got[MAX_CONNECTIONS];
  int connected = 0;
  for (int i = 0; i < n; i++) {
    got[i] = 0;
    closed_at[i] = -1;
    fds[i] = socket(AF_UNIX, SOCK_STREAM, 0);
    opened[i] = now_ms();
    if (connect(fds[i], (struct sockaddr *)&addr, sizeof addr) != 0) {
      close(fds[i]);
      fds[i] = -1;
      continue;
    }
    connected++;
    // The holder may already have closed us: a failed write is part of being refused.
    if (write(fds[i], bytes, hexlen / 2) < 0) {
    }
  }
  printf("connected %d\n", connected);
  fflush(stdout);

  double deadline = now_ms() + timeout;
  int open = connected;
  while (open > 0 && now_ms() < deadline) {
    struct pollfd p[MAX_CONNECTIONS];
    for (int i = 0; i < n; i++) {
      p[i].fd = closed_at[i] < 0 ? fds[i] : -1;
      p[i].events = POLLIN;
      p[i].revents = 0;
    }
    int left = (int)(deadline - now_ms());
    if (poll(p, (nfds_t)n, left > 0 ? left : 0) < 0 && errno != EINTR) break;
    for (int i = 0; i < n; i++) {
      if (p[i].fd < 0 || p[i].revents == 0) continue;
      char buf[4096];
      ssize_t r = read(fds[i], buf, sizeof buf);
      if (r > 0) {
        got[i] += r;
        continue;
      }
      if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
      closed_at[i] = now_ms(); // EOF, or ECONNRESET: closed by the holder
      open--;
    }
  }
  for (int i = 0; i < n; i++) {
    if (fds[i] < 0)
      printf("conn %d refused-at-connect\n", i);
    else if (closed_at[i] >= 0)
      printf("conn %d closed %.1f %ld\n", i, closed_at[i] - opened[i], got[i]);
    else
      printf("conn %d open\n", i);
  }
  return open == 0 ? 0 : 1;
}
