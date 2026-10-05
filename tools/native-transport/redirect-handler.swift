import Foundation

enum RedirectHandling: String { case held, refused }

final class CancelledDuringRedirectDelegate: NSObject, URLSessionDataDelegate {
  let handling: RedirectHandling
  var held: ((URLRequest?) -> Void)?
  var code = 0
  let completed = DispatchSemaphore(value: 0)

  init(handling: RedirectHandling) { self.handling = handling }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    task.cancel()
    if handling == .held { held = completionHandler } else { completionHandler(nil) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    code = (error as NSError?)?.code ?? 0
    session.finishTasksAndInvalidate()
    completed.signal()
  }
}

func run(_ handling: RedirectHandling, url: URL) -> String {
  weak var probe: CancelledDuringRedirectDelegate?
  var code: Int?
  autoreleasepool {
    let delegate = CancelledDuringRedirectDelegate(handling: handling)
    probe = delegate
    URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
      .dataTask(with: url).resume()
    if delegate.completed.wait(timeout: .now() + 5) == .success { code = delegate.code }
  }
  let deadline = Date() + 2
  while probe != nil && Date() < deadline {
    autoreleasepool { _ = RunLoop.main.run(mode: .default, before: Date() + 0.05) }
  }
  let completed = code.map(String.init) ?? "null"
  return "{\"mode\":\"\(handling.rawValue)\",\"completed\":\(completed),\"released\":\(probe == nil)}"
}

let url = URL(string: "http://127.0.0.1:\(CommandLine.arguments[1])/redirect")!
print(run(.held, url: url))
print(run(.refused, url: url))
