# admission-app

A windowless Electron app that forks one utility process running Node's service, as Kea's main forks ptyhost, for the
Linux admission tests of `native/kea-helper` (a holder admits ptyhost) and the recording behind one of their fixtures.
Holders admit a client by its executable only when that file is root's, so the tests need a copy of Electron that only
root can change; they skip, saying so, while `/opt/kea-test/kea-app` is missing. Never `/opt/Kea`: that is where Kea's
own packages install, and a test must not start the real app.

Install it once, as root, on the Linux test machine (Electron 44.5.1 for this machine's architecture, unpacked into
`<electron-dir>`):

```sh
mkdir /opt/kea-test
cp -a <electron-dir>/. /opt/kea-test/
mv /opt/kea-test/electron /opt/kea-test/kea-app
rm -f /opt/kea-test/resources/app.asar
cp -r tools/process-zoo/src/admission-app /opt/kea-test/resources/app
chown -R root:root /opt/kea-test
chmod -R go-w /opt/kea-test
```

The tests start it as `/opt/kea-test/kea-app --no-sandbox --ozone-platform=headless --disable-gpu --user-data-dir=<temp>`
with `KEA_ADMISSION_OUT` (where main writes `{"main":<pid>,"utility":<pid>}`), `KEA_ADMISSION_SOCK` (the socket to
connect to: a holder's, or the test's own listener) and `KEA_ADMISSION_RESULT`
(where the utility process writes `admitted`, `refused` or `error <code>`); `SIGUSR1` to main makes it connect again.
