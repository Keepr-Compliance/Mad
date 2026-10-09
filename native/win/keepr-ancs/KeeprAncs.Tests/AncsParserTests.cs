using System.Text;
using System.Text.Json;
using Keepr.Ancs;

namespace Keepr.Ancs.Tests;

// Fixtures are byte layouts transcribed from Apple's ANCS specification; the section
// each layout comes from is cited on the test. Text values are neutral placeholders.

public class NotificationSourceTests
{
    // ANCS spec, "Notification Source": EventID, EventFlags, CategoryID, CategoryCount, NotificationUID (uint32 LE).
    [Fact]
    public void Decodes_added_preexisting_social_event()
    {
        byte[] data = { 0x00, 0x04, 0x04, 0x02, 0x78, 0x56, 0x34, 0x12 };
        var ev = NotificationSourceEvent.TryParse(data, out var err);

        Assert.Null(err);
        Assert.NotNull(ev);
        Assert.Equal(AncsEventId.NotificationAdded, ev!.EventId);
        Assert.True(ev.IsPreExisting);
        Assert.False(ev.IsSilent);
        Assert.Equal(AncsCategoryId.Social, ev.CategoryId);
        Assert.Equal(2, ev.CategoryCount);
        Assert.Equal(0x12345678u, ev.NotificationUid);
    }

    // EventFlags table: each bit maps to exactly one flag.
    [Theory]
    [InlineData(0x01, AncsEventFlags.Silent)]
    [InlineData(0x02, AncsEventFlags.Important)]
    [InlineData(0x04, AncsEventFlags.PreExisting)]
    [InlineData(0x08, AncsEventFlags.PositiveAction)]
    [InlineData(0x10, AncsEventFlags.NegativeAction)]
    public void Decodes_each_event_flag_bit(int bits, AncsEventFlags expected)
    {
        byte[] data = { 0x00, (byte)bits, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00 };
        var ev = NotificationSourceEvent.TryParse(data, out _)!;
        Assert.Equal(expected, ev.Flags);
        Assert.Equal(expected == AncsEventFlags.PreExisting, ev.IsPreExisting);
    }

    [Theory]
    [InlineData(0x00, AncsEventId.NotificationAdded)]
    [InlineData(0x01, AncsEventId.NotificationModified)]
    [InlineData(0x02, AncsEventId.NotificationRemoved)]
    public void Decodes_event_ids(int id, AncsEventId expected)
    {
        byte[] data = { (byte)id, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00 };
        Assert.Equal(expected, NotificationSourceEvent.TryParse(data, out _)!.EventId);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(7)]
    public void Rejects_short_payload(int len)
    {
        var ev = NotificationSourceEvent.TryParse(new byte[len], out var err);
        Assert.Null(ev);
        Assert.NotNull(err);
    }

    [Fact]
    public void Accepts_long_payload_with_warning()
    {
        var data = new byte[9];
        data[4] = 0x05;
        var ev = NotificationSourceEvent.TryParse(data, out var err);
        Assert.NotNull(ev);
        Assert.Equal(5u, ev!.NotificationUid);
        Assert.NotNull(err);
    }
}

public class GetNotificationAttributesCommandTests
{
    // ANCS spec, "Get Notification Attributes": CommandID(0), UID (uint32 LE), then AttributeIDs;
    // Title/Subtitle/Message each followed by a uint16 LE max length.
    [Fact]
    public void Builds_default_request()
    {
        var cmd = GetNotificationAttributesCommand.Build(0x01020304,
            GetNotificationAttributesCommand.DefaultAttributes(1000));

        byte[] expected =
        {
            0x00,                   // CommandIDGetNotificationAttributes
            0x04, 0x03, 0x02, 0x01, // NotificationUID LE
            0x00,                   // AppIdentifier (no length)
            0x01, 0x80, 0x00,       // Title, max 128
            0x02, 0x80, 0x00,       // Subtitle, max 128
            0x03, 0xE8, 0x03,       // Message, max 1000
            0x05,                   // Date (no length)
        };
        Assert.Equal(expected, cmd);
    }

    [Fact]
    public void Rejects_missing_max_length_for_message()
    {
        Assert.Throws<ArgumentException>(() => GetNotificationAttributesCommand.Build(1,
            new[] { new AttributeRequest(AncsNotificationAttributeId.Message) }));
    }

    [Fact]
    public void Rejects_empty_attribute_list()
    {
        Assert.Throws<ArgumentException>(() =>
            GetNotificationAttributesCommand.Build(1, Array.Empty<AttributeRequest>()));
    }
}

public class DataSourceAssemblerTests
{
    private static readonly AttributeRequest[] Requested =
        GetNotificationAttributesCommand.DefaultAttributes(1000).ToArray();

    // ANCS spec, "Get Notification Attributes" response: CommandID(0), UID (uint32 LE),
    // then { AttributeID, Length (uint16 LE), UTF-8 value }.
    private static byte[] Response(uint uid, params (AncsNotificationAttributeId id, string value)[] attrs)
    {
        var bytes = new List<byte> { 0x00 };
        var uidLe = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(uidLe, uid);
        bytes.AddRange(uidLe);
        foreach (var (id, value) in attrs)
        {
            var v = Encoding.UTF8.GetBytes(value);
            bytes.Add((byte)id);
            bytes.Add((byte)(v.Length & 0xFF));
            bytes.Add((byte)(v.Length >> 8));
            bytes.AddRange(v);
        }
        return bytes.ToArray();
    }

    private static byte[] FullResponse(uint uid, string body = "hello there") => Response(uid,
        (AncsNotificationAttributeId.AppIdentifier, AncsAppIds.MobileSms),
        (AncsNotificationAttributeId.Title, "Sender"),
        (AncsNotificationAttributeId.Subtitle, ""),
        (AncsNotificationAttributeId.Message, body),
        (AncsNotificationAttributeId.Date, "20261009T143012"));

    [Fact]
    public void Parses_single_fragment_response()
    {
        var a = new DataSourceAssembler();
        a.Begin(7, Requested);
        Assert.Equal(AssemblerResult.Complete, a.Append(FullResponse(7)));

        var r = a.Completed!;
        Assert.Equal(7u, r.NotificationUid);
        Assert.Equal(AncsAppIds.MobileSms, r.Get(AncsNotificationAttributeId.AppIdentifier));
        Assert.Equal("Sender", r.Get(AncsNotificationAttributeId.Title));
        Assert.Equal("", r.Get(AncsNotificationAttributeId.Subtitle)); // zero-length is legitimate
        Assert.Equal("hello there", r.Get(AncsNotificationAttributeId.Message));
        Assert.Equal("20261009T143012", r.Get(AncsNotificationAttributeId.Date));
        Assert.False(a.IsActive);
    }

    // ANCS spec, "Control Point and Data Source": responses larger than the MTU arrive
    // split across several Data Source notifications. Sweep EVERY split point (and
    // byte-at-a-time) rather than sampling one.
    [Fact]
    public void Reassembles_at_every_split_point()
    {
        var full = FullResponse(42, "a body long enough to cross several fragments " + new string('x', 60));
        for (var cut = 1; cut < full.Length; cut++)
        {
            var a = new DataSourceAssembler();
            a.Begin(42, Requested);
            Assert.Equal(AssemblerResult.Incomplete, a.Append(full.AsSpan(0, cut)));
            Assert.Equal(AssemblerResult.Complete, a.Append(full.AsSpan(cut)));
            Assert.EndsWith(new string('x', 60), a.Completed!.Get(AncsNotificationAttributeId.Message));
        }
    }

    [Fact]
    public void Reassembles_byte_at_a_time()
    {
        var full = FullResponse(3);
        var a = new DataSourceAssembler();
        a.Begin(3, Requested);
        for (var i = 0; i < full.Length - 1; i++)
            Assert.Equal(AssemblerResult.Incomplete, a.Append(full.AsSpan(i, 1)));
        Assert.Equal(AssemblerResult.Complete, a.Append(full.AsSpan(full.Length - 1, 1)));
    }

    [Fact]
    public void Does_not_depend_on_attribute_order()
    {
        var reordered = Response(9,
            (AncsNotificationAttributeId.Date, "20261009T143012"),
            (AncsNotificationAttributeId.Message, "m"),
            (AncsNotificationAttributeId.AppIdentifier, AncsAppIds.MobileSms),
            (AncsNotificationAttributeId.Subtitle, "s"),
            (AncsNotificationAttributeId.Title, "t"));
        var a = new DataSourceAssembler();
        a.Begin(9, Requested);
        Assert.Equal(AssemblerResult.Complete, a.Append(reordered));
        Assert.Equal("m", a.Completed!.Get(AncsNotificationAttributeId.Message));
    }

    [Fact]
    public void Decodes_multibyte_utf8_split_across_fragments()
    {
        var full = FullResponse(5, "café \U0001F600");
        var a = new DataSourceAssembler();
        a.Begin(5, Requested);
        // The Date tuple (3-byte header + 15-byte value) ends the response; the emoji's
        // 4 UTF-8 bytes end the Message value just before it. Cut 2 bytes into the emoji.
        var cut = full.Length - 18 - 2;
        Assert.Equal(AssemblerResult.Incomplete, a.Append(full.AsSpan(0, cut)));
        Assert.Equal(AssemblerResult.Complete, a.Append(full.AsSpan(cut)));
        Assert.Equal("café \U0001F600", a.Completed!.Get(AncsNotificationAttributeId.Message));
    }

    [Fact]
    public void Errors_on_uid_mismatch()
    {
        var a = new DataSourceAssembler();
        a.Begin(1, Requested);
        Assert.Equal(AssemblerResult.Error, a.Append(FullResponse(2)));
        Assert.Contains("UID", a.Error);
    }

    [Fact]
    public void Errors_on_wrong_command_id()
    {
        var bad = FullResponse(1);
        bad[0] = 0x01;
        var a = new DataSourceAssembler();
        a.Begin(1, Requested);
        Assert.Equal(AssemblerResult.Error, a.Append(bad));
    }

    [Fact]
    public void Errors_on_trailing_bytes()
    {
        var bad = FullResponse(1).Concat(new byte[] { 0xFF }).ToArray();
        var a = new DataSourceAssembler();
        a.Begin(1, Requested);
        Assert.Equal(AssemblerResult.Error, a.Append(bad));
    }

    [Fact]
    public void Errors_on_fragment_with_no_request_outstanding()
    {
        var a = new DataSourceAssembler();
        Assert.Equal(AssemblerResult.Error, a.Append(FullResponse(1)));
    }

    [Fact]
    public void Can_be_reused_for_the_next_request()
    {
        var a = new DataSourceAssembler();
        a.Begin(1, Requested);
        Assert.Equal(AssemblerResult.Complete, a.Append(FullResponse(1, "first")));
        a.Begin(2, Requested);
        Assert.Equal(AssemblerResult.Complete, a.Append(FullResponse(2, "second")));
        Assert.Equal("second", a.Completed!.Get(AncsNotificationAttributeId.Message));
    }
}

public class AncsDateTests
{
    // ANCS spec, NotificationAttributeID table, Date: UTS #35 pattern yyyyMMdd'T'HHmmSS.
    [Fact]
    public void Parses_wire_date_to_unzoned_iso()
    {
        Assert.Equal("2026-10-09T14:30:12", AncsDate.ToIso("20261009T143012"));
    }

    [Fact]
    public void Returns_null_for_null() => Assert.Null(AncsDate.ToIso(null));

    [Theory]
    [InlineData("")]
    [InlineData("2026-10-09T14:30:12")]
    [InlineData("20261009143012")]
    [InlineData("20261309T143012")]
    public void Returns_null_for_malformed(string value)
    {
        Assert.Null(AncsDate.ToIso(value));
    }
}

public class OutputLinesTests
{
    [Fact]
    public void Message_line_matches_contract_and_is_single_line()
    {
        var line = OutputLines.Message("2026-10-09T14:30:12", "Sender", "line one\nline two",
            AncsAppIds.MobileSms, true, 7, null, "Social", "2026-10-09T18:30:12.000Z");

        Assert.DoesNotContain('\n', line);
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        Assert.Equal("message", root.GetProperty("type").GetString());
        Assert.Equal("2026-10-09T14:30:12", root.GetProperty("ts").GetString());
        Assert.Equal("Sender", root.GetProperty("sender").GetString());
        Assert.Equal("line one\nline two", root.GetProperty("body").GetString());
        Assert.Equal(AncsAppIds.MobileSms, root.GetProperty("appId").GetString());
        Assert.True(root.GetProperty("preExisting").GetBoolean());
        Assert.False(root.TryGetProperty("subtitle", out _)); // nulls omitted
    }

    [Fact]
    public void Error_line_carries_stage_status_protocol_error_and_hresult()
    {
        var line = OutputLines.Error("write-control-point", "failed", "ProtocolError", 0xA3, unchecked((int)0x80070490));
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        Assert.Equal("error", root.GetProperty("type").GetString());
        Assert.Equal("write-control-point", root.GetProperty("stage").GetString());
        Assert.Equal("ProtocolError", root.GetProperty("gattStatus").GetString());
        Assert.Equal(0xA3, root.GetProperty("protocolError").GetInt32());
        Assert.Equal("ActionFailed", root.GetProperty("protocolErrorName").GetString());
        Assert.Equal("0x80070490", root.GetProperty("hresult").GetString());
    }

    [Fact]
    public void Status_line_matches_contract()
    {
        using var doc = JsonDocument.Parse(OutputLines.Status("connected"));
        Assert.Equal("status", doc.RootElement.GetProperty("type").GetString());
        Assert.Equal("connected", doc.RootElement.GetProperty("state").GetString());
    }

    [Fact]
    public void Pretty_format()
    {
        Assert.Equal("[2026-10-09T14:30:12] [Sender]: hi", OutputLines.Pretty("2026-10-09T14:30:12", "Sender", "hi"));
    }
}
