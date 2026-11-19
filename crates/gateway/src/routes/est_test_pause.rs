//! Deterministically suspend a single EST request after an awaited lookup.
use std::sync::Mutex;
use tokio::sync::oneshot;

struct Pause {
    organization: String,
    point: &'static str,
    reached: oneshot::Sender<()>,
    resume: oneshot::Receiver<()>,
}
static PAUSE: Mutex<Option<Pause>> = Mutex::new(None);

pub(crate) fn install(
    organization: &str,
    point: &'static str,
) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
    let (reached_tx, reached_rx) = oneshot::channel();
    let (resume_tx, resume_rx) = oneshot::channel();
    *PAUSE.lock().unwrap() = Some(Pause {
        organization: organization.into(),
        point,
        reached: reached_tx,
        resume: resume_rx,
    });
    (reached_rx, resume_tx)
}

pub(crate) async fn point(organization: &str, point: &'static str) {
    let pause = {
        let mut pending = PAUSE.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|p| p.organization == organization && p.point == point)
        {
            pending.take()
        } else {
            None
        }
    };
    if let Some(pause) = pause {
        let _ = pause.reached.send(());
        let _ = pause.resume.await;
    }
}
