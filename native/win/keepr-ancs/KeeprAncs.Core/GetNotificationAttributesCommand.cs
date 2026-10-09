using System.Buffers.Binary;

namespace Keepr.Ancs;

/// <summary>One requested attribute, with the max length the spec requires for Title/Subtitle/Message.</summary>
public readonly record struct AttributeRequest(AncsNotificationAttributeId Id, ushort MaxLength = 0)
{
    /// <summary>
    /// ANCS spec, section "Get Notification Attributes": Title, Subtitle and Message
    /// "must be followed by a 2-byte max length parameter". No other attribute takes one.
    /// </summary>
    public static bool RequiresMaxLength(AncsNotificationAttributeId id) =>
        id is AncsNotificationAttributeId.Title
           or AncsNotificationAttributeId.Subtitle
           or AncsNotificationAttributeId.Message;
}

/// <summary>
/// Builds the Control Point write for Get Notification Attributes.
///
/// ANCS spec, section "Get Notification Attributes", figure "Format of a Get
/// Notification Attributes command":
///   CommandID (uint8) = 0
///   NotificationUID (uint32 LE)
///   AttributeIDs: repeated { AttributeID (uint8) [, MaxLength (uint16 LE) for Title/Subtitle/Message] }
/// </summary>
public static class GetNotificationAttributesCommand
{
    public const ushort DefaultTitleMax = 128;
    public const ushort DefaultSubtitleMax = 128;
    public const ushort DefaultMessageMax = 1000;

    public static IReadOnlyList<AttributeRequest> DefaultAttributes(ushort messageMax = DefaultMessageMax) =>
        new[]
        {
            new AttributeRequest(AncsNotificationAttributeId.AppIdentifier),
            new AttributeRequest(AncsNotificationAttributeId.Title, DefaultTitleMax),
            new AttributeRequest(AncsNotificationAttributeId.Subtitle, DefaultSubtitleMax),
            new AttributeRequest(AncsNotificationAttributeId.Message, messageMax),
            new AttributeRequest(AncsNotificationAttributeId.Date),
        };

    public static byte[] Build(uint notificationUid, IReadOnlyList<AttributeRequest> attributes)
    {
        if (attributes.Count == 0)
            throw new ArgumentException("At least one attribute must be requested", nameof(attributes));

        var size = 1 + 4;
        foreach (var a in attributes)
            size += AttributeRequest.RequiresMaxLength(a.Id) ? 3 : 1;

        var buf = new byte[size];
        buf[0] = (byte)AncsCommandId.GetNotificationAttributes;
        BinaryPrimitives.WriteUInt32LittleEndian(buf.AsSpan(1, 4), notificationUid);
        var i = 5;
        foreach (var a in attributes)
        {
            buf[i++] = (byte)a.Id;
            if (AttributeRequest.RequiresMaxLength(a.Id))
            {
                if (a.MaxLength == 0)
                    throw new ArgumentException($"{a.Id} requires a non-zero max length", nameof(attributes));
                BinaryPrimitives.WriteUInt16LittleEndian(buf.AsSpan(i, 2), a.MaxLength);
                i += 2;
            }
        }
        return buf;
    }
}
