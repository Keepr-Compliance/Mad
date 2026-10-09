using System.Globalization;

namespace Keepr.Ancs;

/// <summary>
/// ANCS spec, appendix table "NotificationAttributeID Values", Date: "a string that
/// uses the Unicode Technical Standard (UTS) #35 date format pattern
/// yyyyMMdd'T'HHmmSS". In UTS #35 "SS" is fractional seconds, but the observed and
/// documented wire value is whole seconds (e.g. 20141023T143012), so it is parsed
/// as .NET "yyyyMMdd'T'HHmmss".
///
/// The wire value carries NO time zone: it is the iPhone's local wall-clock time.
/// It is emitted as an unzoned ISO 8601 string (no 'Z', no offset).
/// </summary>
public static class AncsDate
{
    private const string WireFormat = "yyyyMMdd'T'HHmmss";
    private const string IsoFormat = "yyyy-MM-dd'T'HH:mm:ss";

    public static bool TryParse(string? value, out DateTime local)
    {
        local = default;
        if (string.IsNullOrWhiteSpace(value)) return false;
        return DateTime.TryParseExact(
            value.Trim(), WireFormat, CultureInfo.InvariantCulture,
            DateTimeStyles.None, out local);
    }

    /// <summary>Returns the unzoned ISO string, or null when the value is absent/malformed.</summary>
    public static string? ToIso(string? value) =>
        TryParse(value, out var dt) ? dt.ToString(IsoFormat, CultureInfo.InvariantCulture) : null;
}
