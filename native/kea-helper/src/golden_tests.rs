//! Golden bytes shared with `packages/protocol/src/holder.ts` (U-HLD-1): every frame in both
//! directions, the ring header and the run-dir rule, from `fixtures/protocol/holder-golden.json`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::proto::{self, AttachMode, ClientFrame, Decoder, Event, Hello, HolderFrame, SignalTarget, Stat};
use crate::ring;

fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/protocol/holder-golden.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn u(f: &Value, k: &str) -> u64 {
    f[k].as_u64().unwrap_or_else(|| panic!("field {k}"))
}

fn i(f: &Value, k: &str) -> i64 {
    f[k].as_i64().unwrap_or_else(|| panic!("field {k}"))
}

fn client_frame(t: u8, f: &Value) -> Option<ClientFrame> {
    Some(match t {
        proto::ty::HELLO => ClientFrame::Hello { proto: u(f, "proto") as u16 },
        proto::ty::ATTACH => ClientFrame::Attach {
            mode: [AttachMode::FromSeq, AttachMode::Earliest, AttachMode::Latest][u(f, "mode") as usize],
            seq: u(f, "seq"),
        },
        proto::ty::RESIZE => ClientFrame::Resize {
            cols: u(f, "cols") as u16,
            rows: u(f, "rows") as u16,
            xpx: u(f, "xpx") as u16,
            ypx: u(f, "ypx") as u16,
        },
        proto::ty::ACK => ClientFrame::Ack { seq: u(f, "seq") },
        proto::ty::SIGNAL => ClientFrame::Signal {
            signo: u(f, "signo") as u8,
            target: [SignalTarget::Child, SignalTarget::Foreground, SignalTarget::Session][u(f, "target") as usize],
        },
        proto::ty::TERMINATE => ClientFrame::Terminate { grace_ms: u(f, "graceMs") as u32 },
        proto::ty::STAT => ClientFrame::Stat,
        proto::ty::DETACH => ClientFrame::Detach,
        proto::ty::RELEASE => ClientFrame::Release,
        _ => return None, // INPUT
    })
}

fn holder_frame(t: u8, f: &Value) -> HolderFrame {
    let s = |k: &str| f[k].as_str().unwrap().as_bytes().to_vec();
    match t {
        proto::ty::H_HELLO => HolderFrame::Hello(Hello {
            proto: u(f, "proto") as u16,
            child_pid: u(f, "childPid") as u32,
            cols: u(f, "cols") as u16,
            rows: u(f, "rows") as u16,
            earliest: u(f, "earliestSeq"),
            latest: u(f, "latestSeq"),
            exited: u(f, "exited") != 0,
            code: i(f, "code") as i32,
            signal: u(f, "signal") as u8,
            pty_id: s("ptyId"),
        }),
        proto::ty::H_OUTPUT => HolderFrame::Output { seq: u(f, "seq"), data: unhex(f["bytesHex"].as_str().unwrap()) },
        proto::ty::H_EXIT => HolderFrame::Exit { code: i(f, "code") as i32, signal: u(f, "signal") as u8 },
        proto::ty::H_STAT => HolderFrame::Stat(Stat {
            child_pid: u(f, "childPid") as u32,
            fg_pid: u(f, "fgPid") as u32,
            fg_name: s("fgName"),
            cwd: s("cwd"),
            pids: f["descendants"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect(),
        }),
        proto::ty::H_ERROR => HolderFrame::Error { code: u(f, "code") as u16, message: s("message") },
        _ => panic!("unexpected holder frame type {t}"),
    }
}

#[test]
fn r_hld_2_golden_frames_both_directions() {
    let g = golden();
    let frames = g["frames"].as_array().unwrap();
    assert!(frames.len() >= 20);
    for fr in frames {
        let name = fr["name"].as_str().unwrap();
        let t = fr["type"].as_u64().unwrap() as u8;
        let bytes = unhex(fr["hex"].as_str().unwrap());
        let f = &fr["fields"];
        assert_eq!(bytes[0], t, "{name}: type byte");
        match fr["dir"].as_str().unwrap() {
            "c2h" => {
                let encoded = match client_frame(t, f) {
                    Some(cf) => proto::encode_client(&cf),
                    None => proto::encode_input(&unhex(f["bytesHex"].as_str().unwrap())),
                };
                assert_eq!(hex(&encoded), hex(&bytes), "{name}: encode");
                // Decode on the holder side, both whole and byte by byte.
                for split in [bytes.len(), 1] {
                    let mut d = Decoder::new();
                    let mut input = Vec::new();
                    let mut got = None;
                    for chunk in bytes.chunks(split) {
                        let mut rest = chunk;
                        while let (used, Some(ev)) = d.next(rest, usize::MAX) {
                            rest = &rest[used..];
                            match ev.unwrap() {
                                Event::Frame(cf) => got = Some(cf),
                                Event::Input(b) => input.extend_from_slice(b),
                                Event::Unknown(t) => panic!("{name}: unknown {t}"),
                            }
                        }
                    }
                    assert!(d.at_boundary(), "{name}: whole frame consumed");
                    match client_frame(t, f) {
                        Some(cf) => assert_eq!(got, Some(cf), "{name}: decode"),
                        None => assert_eq!(hex(&input), f["bytesHex"].as_str().unwrap(), "{name}: input bytes"),
                    }
                }
            }
            "h2c" => {
                let hf = holder_frame(t, f);
                assert_eq!(hex(&proto::encode_holder_frame(&hf)), hex(&bytes), "{name}: encode");
                assert_eq!(proto::decode_holder_frame(t, &bytes[proto::HEADER_LEN..]), Ok(hf), "{name}: decode");
            }
            other => panic!("{name}: dir {other}"),
        }
    }
    // The error codes the holder uses are the golden ones.
    let codes = &g["errorCodes"];
    for (k, v) in [
        ("unknownType", proto::code::UNKNOWN_TYPE),
        ("badLength", proto::code::BAD_LENGTH),
        ("badProto", proto::code::BAD_PROTO),
        ("notHello", proto::code::NOT_HELLO),
        ("internal", proto::code::INTERNAL),
        ("childAlive", proto::code::CHILD_ALIVE),
        ("notAttached", proto::code::NOT_ATTACHED),
    ] {
        assert_eq!(codes[k].as_u64(), Some(v as u64), "{k}");
    }
}

#[test]
fn r_hld_1_golden_ring_header() {
    let g = golden();
    let r = &g["ring"];
    assert_eq!(r["magic"].as_str().unwrap().as_bytes(), ring::MAGIC);
    assert_eq!(r["version"].as_u64(), Some(ring::VERSION as u64));
    assert_eq!(r["headerBytes"].as_u64(), Some(ring::HEADER as u64));
    let ex = &r["example"];
    let h = ring::Header { capacity: u(ex, "capacity"), earliest: u(ex, "earliestSeq"), latest: u(ex, "latestSeq") };
    let bytes = unhex(ex["hex"].as_str().unwrap());
    assert_eq!(hex(&ring::encode_header(&h)), hex(&bytes));
    assert_eq!(ring::decode_header(&bytes), Some(h));
    // And a real ring file at that state carries exactly those header bytes.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("g.ring");
    let mut rg = ring::Ring::create(&path, h.capacity).unwrap();
    rg.append(&vec![b'x'; h.latest as usize]);
    assert_eq!(hex(&std::fs::read(&path).unwrap()[..ring::HEADER]), hex(&bytes));
}

#[test]
fn r_agt_1_golden_run_dir() {
    let g = golden();
    for case in g["runDir"].as_array().unwrap() {
        let home = Path::new(case["home"].as_str().unwrap());
        let uid = case["uid"].as_u64().unwrap() as u32;
        let runtime = case["runtimeDir"].as_str().map(Path::new);
        assert_eq!(crate::rundir::run_dir(home, uid, runtime), PathBuf::from(case["runDir"].as_str().unwrap()), "{home:?} {runtime:?}");
    }
    // Reference FNV-1a 64 vectors.
    assert_eq!(crate::rundir::fnv1a64(b""), 0xcbf29ce484222325);
    assert_eq!(crate::rundir::fnv1a64(b"a"), 0xaf63dc4c8601ec8c);
}
