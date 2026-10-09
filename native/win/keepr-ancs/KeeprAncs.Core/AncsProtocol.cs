namespace Keepr.Ancs;

// Constants from Apple's "Apple Notification Center Service (ANCS) Specification"
// (developer.apple.com, ANCS spec). Section names are cited next to each block;
// values are transcribed from the spec's tables, not inferred.

/// <summary>GATT UUIDs. ANCS spec, section "The Apple Notification Center Service".</summary>
public static class AncsUuids
{
    public static readonly Guid Service = new("7905F431-B5CE-4E99-A40F-4B1E122D00D0");
    /// <summary>Notifiable. ANCS spec, section "Notification Source".</summary>
    public static readonly Guid NotificationSource = new("9FBF120D-6301-42D9-8C58-25E699A21DBD");
    /// <summary>Writeable with response. ANCS spec, section "Control Point and Data Source".</summary>
    public static readonly Guid ControlPoint = new("69D1D8F3-45E1-49A8-9821-9BBDFDAAD9D9");
    /// <summary>Notifiable. ANCS spec, section "Control Point and Data Source".</summary>
    public static readonly Guid DataSource = new("22EAC6E9-24D6-4BB5-BE44-B36ACE7C7BFB");
}

/// <summary>ANCS spec, appendix table "EventID Values".</summary>
public enum AncsEventId : byte
{
    NotificationAdded = 0,
    NotificationModified = 1,
    NotificationRemoved = 2,
}

/// <summary>ANCS spec, appendix table "EventFlags" (bitmask).</summary>
[Flags]
public enum AncsEventFlags : byte
{
    None = 0,
    Silent = 1 << 0,
    Important = 1 << 1,
    PreExisting = 1 << 2,
    PositiveAction = 1 << 3,
    NegativeAction = 1 << 4,
}

/// <summary>ANCS spec, appendix table "CategoryID Values".</summary>
public enum AncsCategoryId : byte
{
    Other = 0,
    IncomingCall = 1,
    MissedCall = 2,
    Voicemail = 3,
    Social = 4,
    Schedule = 5,
    Email = 6,
    News = 7,
    HealthAndFitness = 8,
    BusinessAndFinance = 9,
    Location = 10,
    Entertainment = 11,
}

/// <summary>ANCS spec, appendix table "CommandID Values".</summary>
public enum AncsCommandId : byte
{
    GetNotificationAttributes = 0,
    GetAppAttributes = 1,
    PerformNotificationAction = 2,
}

/// <summary>ANCS spec, appendix table "NotificationAttributeID Values".</summary>
public enum AncsNotificationAttributeId : byte
{
    AppIdentifier = 0,
    Title = 1,        // followed by a 2-byte max length in the request
    Subtitle = 2,     // followed by a 2-byte max length in the request
    Message = 3,      // followed by a 2-byte max length in the request
    MessageSize = 4,
    Date = 5,
    PositiveActionLabel = 6,
    NegativeActionLabel = 7,
}

/// <summary>
/// ATT error codes the Control Point returns. ANCS spec, section "Error Codes".
/// Surface in WinRT as GattWriteResult.ProtocolError.
/// </summary>
public static class AncsErrorCodes
{
    public const byte UnknownCommand = 0xA0;
    public const byte InvalidCommand = 0xA1;
    public const byte InvalidParameter = 0xA2;
    public const byte ActionFailed = 0xA3;

    public static string Describe(byte code) => code switch
    {
        UnknownCommand => "UnknownCommand",
        InvalidCommand => "InvalidCommand",
        InvalidParameter => "InvalidParameter",
        ActionFailed => "ActionFailed",
        _ => $"ATT error 0x{code:X2}",
    };
}

public static class AncsAppIds
{
    /// <summary>Messages app bundle id (SMS and iMessage both arrive under it).</summary>
    public const string MobileSms = "com.apple.MobileSMS";
}
