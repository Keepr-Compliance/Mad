using System.Text.Encodings.Web;
using System.Text.Json;

namespace Keepr.Ancs;

/// <summary>
/// The stdout contract (BACKLOG-3839): one JSON object per line.
///   {"type":"message","ts":"<ISO>","sender":"...","body":"...","appId":"...","preExisting":bool, ...}
///   {"type":"status","state":"connected|disconnected|searching", ...}
///   {"type":"error","stage":"...","gattStatus":"...","protocolError":n,"hresult":"0x...", ...}
/// Extra fields are additive diagnostics; consumers must ignore unknown fields.
/// Null fields are omitted.
/// </summary>
public static class OutputLines
{
    private static readonly JsonSerializerOptions Options = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    public static string Message(
        string? ts, string? sender, string? body, string? appId, bool preExisting,
        uint uid, string? subtitle, string category, string receivedAt) =>
        Serialize(new Dictionary<string, object?>
        {
            ["type"] = "message",
            ["ts"] = ts,
            ["sender"] = sender,
            ["body"] = body,
            ["appId"] = appId,
            ["preExisting"] = preExisting,
            ["uid"] = uid,
            ["subtitle"] = string.IsNullOrEmpty(subtitle) ? null : subtitle,
            ["category"] = category,
            ["bodyLength"] = body?.Length,
            ["receivedAt"] = receivedAt,
        });

    public static string Status(string state, string? detail = null, string? device = null) =>
        Serialize(new Dictionary<string, object?>
        {
            ["type"] = "status",
            ["state"] = state,
            ["detail"] = detail,
            ["device"] = device,
        });

    public static string Error(
        string stage, string message, string? gattStatus = null, byte? protocolError = null,
        int? hresult = null) =>
        Serialize(new Dictionary<string, object?>
        {
            ["type"] = "error",
            ["stage"] = stage,
            ["message"] = message,
            ["gattStatus"] = gattStatus,
            ["protocolError"] = protocolError is null ? null : (int)protocolError.Value,
            ["protocolErrorName"] = protocolError is null ? null : AncsErrorCodes.Describe(protocolError.Value),
            ["hresult"] = hresult is null ? null : $"0x{hresult.Value:X8}",
        });

    /// <summary>Human mode (--pretty): "[Timestamp] [Sender]: [Body]".</summary>
    public static string Pretty(string? ts, string? sender, string? body) =>
        $"[{ts ?? "?"}] [{sender ?? "?"}]: {body ?? ""}";

    // JsonIgnoreCondition does not apply to dictionary entries, so nulls are dropped here.
    private static string Serialize(Dictionary<string, object?> fields) =>
        JsonSerializer.Serialize(
            fields.Where(kv => kv.Value is not null).ToDictionary(kv => kv.Key, kv => kv.Value),
            Options);
}
