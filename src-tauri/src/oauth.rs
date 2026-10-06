//! One-shot loopback HTTP listener for the Google OAuth redirect (RFC 8252 section 7.3).
//!
//! The app opens the system browser at Google's consent page with
//! `redirect_uri=http://127.0.0.1:<port>`; after the user approves, the browser is sent to that
//! address and this listener captures the query string (`code=...&state=...`).

use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

const DONE_PAGE: &str = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>Yobsidian</title></head>\
<body style=\"font-family:sans-serif;text-align:center;margin-top:20vh\">\
<h2>로그인이 끝났어요</h2><p>이 창은 닫고 Yobsidian으로 돌아가세요.</p></body></html>";

/// Bind a random free port on the loopback interface only.
pub fn listen() -> io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Wait for the redirect and return its query string (without the `?`).
/// Requests without `code=` or `error=` (a favicon fetch, a port scan) are answered and ignored.
pub fn wait(listener: TcpListener, timeout: Duration) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(query) = handle(stream) {
                    return Ok(query);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("timeout".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn handle(mut stream: TcpStream) -> Option<String> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while buf.len() < 16 * 1024 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let line = head.lines().next().unwrap_or("");
    let target = line.strip_prefix("GET ")?.split(' ').next()?;
    let query = target.split_once('?').map(|(_, q)| q.to_string());
    let body = DONE_PAGE;
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
    query.filter(|q| q.split('&').any(|kv| kv.starts_with("code=") || kv.starts_with("error=")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(port: u16, target: &str) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn captures_the_redirect_query_and_ignores_noise() {
        let (listener, port) = listen().unwrap();
        let t = std::thread::spawn(move || wait(listener, Duration::from_secs(5)));
        get(port, "/favicon.ico");
        get(port, "/?code=4%2F0abc&state=xyz&scope=drive");
        assert_eq!(t.join().unwrap().unwrap(), "code=4%2F0abc&state=xyz&scope=drive");
    }

    #[test]
    fn reports_denied_consent_and_times_out() {
        let (listener, port) = listen().unwrap();
        let t = std::thread::spawn(move || wait(listener, Duration::from_secs(5)));
        get(port, "/?error=access_denied&state=s");
        assert_eq!(t.join().unwrap().unwrap(), "error=access_denied&state=s");

        let (listener, _) = listen().unwrap();
        assert_eq!(wait(listener, Duration::from_millis(150)).unwrap_err(), "timeout");
    }
}
