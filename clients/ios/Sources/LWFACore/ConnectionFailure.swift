import Foundation

/// Fixed descriptions deliberately exclude NSError userInfo and credential-bearing URLs.
public struct ConnectionFailure: Sendable {
    public let message: String
    public let retryable: Bool

    public init(_ error: Error, httpStatus: Int? = nil, replaced: Bool = false) {
        if replaced {
            message = "This session was opened elsewhere. Connect again to resume here."
            retryable = false
            return
        }
        if let status = httpStatus, status >= 400 {
            switch status {
            case 401, 403: message = "The server rejected this password or account (HTTP \(status))."
            case 404: message = "The server could not find the lwfa connection endpoint (HTTP 404). Check the address and proxy path."
            default: message = "The server rejected the connection (HTTP \(status))."
            }
            retryable = status == 408 || status == 429 || status >= 500
            return
        }
        if error is ProtocolError {
            message = "The server sent an unsupported or invalid stream message."
            retryable = false
            return
        }
        let failure = error as NSError
        guard failure.domain == NSURLErrorDomain else {
            message = "The connection failed. Check the server address and network, then try again."
            retryable = true
            return
        }
        let description: String
        switch URLError.Code(rawValue: failure.code) {
        case .serverCertificateUntrusted, .serverCertificateHasUnknownRoot:
            description = "The server certificate is not trusted by this iPad. Use your trusted HTTPS domain, or install and trust your server's certificate authority in iPad Settings."
            retryable = false
        case .serverCertificateHasBadDate, .serverCertificateNotYetValid:
            description = "The server certificate is expired or not yet valid. Check the certificate and the iPad's date and time."
            retryable = false
        case .secureConnectionFailed:
            description = "A secure TLS connection could not be established. Check the certificate, server name, and HTTPS port."
            retryable = false
        case .clientCertificateRequired, .clientCertificateRejected:
            description = "The server requires a client certificate or rejected the supplied certificate."
            retryable = false
        case .cannotFindHost, .dnsLookupFailed:
            description = "The server name could not be resolved. Check the address. For a Tailscale name, check that Tailscale is connected on the iPad."
            retryable = true
        case .cannotConnectToHost:
            description = "The server could not be reached. Check the address, port, and whether lwfa is running."
            retryable = true
        case .badServerResponse:
            description = "The server did not accept the WebSocket connection. Check that this address and proxy serve lwfa."
            retryable = false
        case .userAuthenticationRequired, .userCancelledAuthentication:
            description = "The connection requires authentication. Check the password and any authentication configured on your proxy."
            retryable = false
        case .timedOut:
            description = "The connection timed out. Check the server address and network."
            retryable = true
        case .notConnectedToInternet, .dataNotAllowed:
            description = "Network access is unavailable. Check Wi-Fi or Tailscale and allow lwfa Local Network access in iPad Settings."
            retryable = true
        case .networkConnectionLost:
            description = "The network connection was interrupted."
            retryable = true
        case .appTransportSecurityRequiresSecureConnection:
            description = "iPadOS blocked this connection because it did not meet transport security requirements. Check the HTTPS address and certificate."
            retryable = false
        case .badURL, .unsupportedURL:
            description = "The server address is invalid. Enter an HTTPS address with the correct port."
            retryable = false
        default:
            description = "The network connection failed. Check the server address and network."
            retryable = true
        }
        message = "\(description) (Network error \(failure.code).)"
    }
}
