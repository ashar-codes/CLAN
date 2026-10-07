// CLAN.DirectHelper: the only native code CLAN runs on Windows for Direct Network. A fixed command set (validated again
// here and in TypeScript) — never arbitrary commands, no shell, no netsh hosted network.
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;
using Windows.Devices.Radios;
using Windows.Devices.WiFi;
using Windows.Devices.WiFiDirect;
using Windows.Foundation.Metadata;
using Windows.Networking.Connectivity;
using Windows.Networking.NetworkOperators;
using Windows.Security.Credentials;

namespace Clan.DirectHelper;

static class Program
{
    static readonly Guid Service = Guid.Parse("6f1a0001-7c3b-4d5e-9a2b-c1a4e5f60001");
    static readonly Guid Rx = Guid.Parse("6f1a0002-7c3b-4d5e-9a2b-c1a4e5f60001");
    static readonly Guid Tx = Guid.Parse("6f1a0003-7c3b-4d5e-9a2b-c1a4e5f60001");
    static readonly Regex SsidRe = new("^CLAN-[0-9A-Z]{4}$");
    static readonly Regex PassRe = new("^[A-Za-z0-9]{16,63}$");
    static readonly Regex RuleRe = new("^CLAN Direct [0-9a-f-]{36} (bootstrap|https|peer)$");
    static readonly object Out = new();

    static WiFiDirectAdvertisementPublisher? publisher;
    static NetworkOperatorTetheringManager? tethering;
    static string? activeSsid;
    static GattServiceProvider? gattProvider;
    static GattLocalCharacteristic? txChar;
    static readonly Dictionary<string, GattSubscribedClient> subscribers = new();
    static readonly Dictionary<string, (BluetoothLEDevice dev, GattCharacteristic rx, GattCharacteristic tx)> clients = new();

    static void Emit(JsonObject o) { lock (Out) { Console.Out.WriteLine(o.ToJsonString()); Console.Out.Flush(); } }

    static async Task Main()
    {
        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            if (line.Length > 8192) continue;
            JsonObject? req;
            try { req = JsonNode.Parse(line) as JsonObject; } catch { continue; }
            if (req is null) continue;
            var id = req["id"]?.GetValue<string>() ?? "";
            _ = Task.Run(async () =>
            {
                try { Emit(new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = await Handle(req) }); }
                catch (Exception e) { Emit(new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = e.Message.Length > 300 ? e.Message[..300] : e.Message }); }
            });
        }
        await StopNetwork();
    }

    static string Str(JsonObject r, string k, Regex? re = null)
    {
        var v = r[k]?.GetValue<string>() ?? throw new ArgumentException($"missing {k}");
        if (re != null && !re.IsMatch(v)) throw new ArgumentException($"invalid {k}");
        return v;
    }

    static async Task<JsonNode?> Handle(JsonObject r) => Str(r, "cmd") switch
    {
        "probe" => await Probe(),
        "start" => await Start(Str(r, "strategy"), Str(r, "ssid", SsidRe), Str(r, "passphrase", PassRe), Str(r, "band")),
        "status" => await Status(),
        "stop" => await StopNetwork(),
        "firewall.add" => FirewallAdd(r["rules"]!.AsArray()),
        "firewall.remove" => FirewallRemove(),
        "wifi.connect" => await WifiConnect(Str(r, "ssid", SsidRe), Str(r, "passphrase", PassRe)),
        "ble.advertise" => await BleAdvertise(Str(r, "tag", new Regex("^[0-9a-f]{8}$"))),
        "ble.stop" => BleStop(),
        "ble.notify" => await BleNotify(Str(r, "conn"), Convert.FromBase64String(Str(r, "frame"))),
        "ble.scan" => await BleScan(r["ms"]!.GetValue<int>()),
        "ble.connect" => await BleConnect(Str(r, "peer", new Regex("^[0-9a-f]{12}$"))),
        "ble.write" => await BleWrite(Str(r, "conn"), Convert.FromBase64String(Str(r, "frame"))),
        "ble.close" => BleClose(Str(r, "conn")),
        _ => throw new ArgumentException("unknown command"),
    };

    // ---------- capability probe ----------
    static async Task<JsonNode> Probe()
    {
        var wifi = (await DeviceInformation.FindAllAsync(WiFiAdapter.GetDeviceSelector())).Count > 0;
        // API presence only: whether this adapter/driver can really be a Wi-Fi Direct group owner is known when Start() runs.
        var wfd = ApiInformation.IsTypePresent("Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher");
        var profile = NetworkInformation.GetInternetConnectionProfile();
        var upstream = profile?.GetNetworkConnectivityLevel() == NetworkConnectivityLevel.InternetAccess;
        string? hotspotReason = null;
        var hotspot = false;
        var bands = new JsonArray();
        var perSession = ApiInformation.IsTypePresent("Windows.Networking.NetworkOperators.NetworkOperatorTetheringSessionAccessPointConfiguration");
        if (!perSession) hotspotReason = "Per-session Mobile Hotspot needs Windows 11 24H2 or later.";
        else if (profile is null) hotspotReason = "Mobile Hotspot needs an upstream connection.";
        else
        {
            var cap = NetworkOperatorTetheringManager.GetTetheringCapabilityFromConnectionProfile(profile);
            hotspot = cap == TetheringCapability.Enabled;
            if (!hotspot) hotspotReason = $"Mobile Hotspot unavailable ({cap}).";
            else
            {
                var cfg = new NetworkOperatorTetheringSessionAccessPointConfiguration();
                if (await cfg.IsBandSupportedAsync(TetheringWiFiBand.TwoPointFourGigahertz)) bands.Add("2.4");
                if (await cfg.IsBandSupportedAsync(TetheringWiFiBand.FiveGigahertz)) bands.Add("5");
            }
        }
        return new JsonObject
        {
            ["osBuild"] = Environment.OSVersion.Version.Build,
            ["wifiAdapter"] = wifi,
            ["bluetooth"] = await BluetoothState(),
            ["legacy"] = new JsonObject { ["available"] = wifi && wfd, ["reason"] = wifi && wfd ? null : "This Wi-Fi adapter/driver does not support Wi-Fi Direct." },
            ["hotspot"] = new JsonObject { ["available"] = hotspot, ["reason"] = hotspotReason, ["upstream"] = upstream, ["bands"] = bands },
        };
    }

    static async Task<string> BluetoothState()
    {
        try
        {
            var a = await BluetoothAdapter.GetDefaultAsync();
            if (a is null || !a.IsLowEnergySupported || !a.IsPeripheralRoleSupported) return "unsupported";
            var radio = await a.GetRadioAsync();
            return radio?.State == RadioState.On ? "on" : "off";
        }
        catch (UnauthorizedAccessException) { return "denied"; }
    }

    // ---------- network ----------
    static async Task<JsonNode> Start(string strategy, string ssid, string pass, string band)
    {
        await StopNetwork();
        if (strategy == "wifi-direct-legacy")
        {
            var p = new WiFiDirectAdvertisementPublisher();
            p.Advertisement.IsAutonomousGroupOwnerEnabled = true;
            p.Advertisement.LegacySettings.IsEnabled = true;
            p.Advertisement.LegacySettings.Ssid = ssid;
            p.Advertisement.LegacySettings.Passphrase = new PasswordCredential { Password = pass };
            p.Advertisement.ListenStateDiscoverability = WiFiDirectAdvertisementListenStateDiscoverability.None;
            var started = new TaskCompletionSource<WiFiDirectAdvertisementPublisherStatus>();
            p.StatusChanged += (_, e) => { if (e.Status != WiFiDirectAdvertisementPublisherStatus.Created) started.TrySetResult(e.Status); };
            p.Start();
            var st = await Task.WhenAny(started.Task, Task.Delay(15000)) == started.Task ? started.Task.Result : p.Status;
            if (st != WiFiDirectAdvertisementPublisherStatus.Started) { p.Stop(); throw new InvalidOperationException($"Wi-Fi Direct did not start ({st})."); }
            publisher = p;
        }
        else if (strategy == "mobile-hotspot")
        {
            var profile = NetworkInformation.GetInternetConnectionProfile() ?? throw new InvalidOperationException("Mobile Hotspot needs an upstream connection.");
            var m = NetworkOperatorTetheringManager.CreateFromConnectionProfile(profile);
            var cfg = new NetworkOperatorTetheringSessionAccessPointConfiguration { Ssid = ssid, Passphrase = pass, AuthenticationKind = TetheringWiFiAuthenticationKind.Wpa2 };
            if (band == "2.4") cfg.Band = TetheringWiFiBand.TwoPointFourGigahertz;
            else if (band == "5") cfg.Band = TetheringWiFiBand.FiveGigahertz;
            var r = await m.StartTetheringAsync(cfg);
            if (r.Status != TetheringOperationStatus.Success) throw new InvalidOperationException($"Mobile Hotspot did not start ({r.Status}). {r.AdditionalErrorMessage}");
            tethering = m;
        }
        else throw new ArgumentException("unknown strategy");
        activeSsid = ssid;
        // Both strategies surface as the "Wi-Fi Direct Virtual Adapter"; wait for its IPv4 address (DHCP/ICS assigns it).
        for (var i = 0; i < 60; i++) { var s = await Status(); if (s["hostAddress"] is not null) return s; await Task.Delay(250); }
        await StopNetwork();
        throw new InvalidOperationException("The network started but got no local address.");
    }

    static (string? name, string? addr) DirectInterface()
    {
        foreach (var n in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (n.OperationalStatus != OperationalStatus.Up || !n.Description.Contains("Wi-Fi Direct Virtual Adapter", StringComparison.OrdinalIgnoreCase)) continue;
            var a = n.GetIPProperties().UnicastAddresses.FirstOrDefault(x => x.Address.AddressFamily == AddressFamily.InterNetwork);
            if (a != null) return (n.Name, a.Address.ToString());
        }
        return (null, null);
    }

    static Task<JsonNode> Status()
    {
        var up = (publisher?.Status == WiFiDirectAdvertisementPublisherStatus.Started) || tethering?.TetheringOperationalState == TetheringOperationalState.On;
        var (name, addr) = up ? DirectInterface() : (null, null);
        return Task.FromResult<JsonNode>(new JsonObject
        {
            ["up"] = up, ["ssid"] = up ? activeSsid : null, ["clients"] = (int)(tethering?.ClientCount ?? 0),
            ["band"] = null, ["hostAddress"] = addr, ["interfaceName"] = name,
        });
    }

    static async Task<JsonNode?> StopNetwork()
    {
        publisher?.Stop(); publisher = null;
        if (tethering != null) { await tethering.StopTetheringAsync(); tethering = null; }
        activeSsid = null;
        return null;
    }

    // ---------- firewall (Windows Firewall COM API; needs elevation, otherwise the installer's program rule applies) ----------
    static JsonNode FirewallAdd(JsonArray rules)
    {
        dynamic policy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2")!)!;
        foreach (var n in rules)
        {
            var r = n!.AsObject();
            var name = Str(r, "name", RuleRe);
            var port = r["localPort"]!.GetValue<int>();
            if (port < 1 || port > 65535 || Str(r, "remote") != "LocalSubnet" || Str(r, "interfaceType") != "Wireless" || Str(r, "protocol") != "TCP") throw new ArgumentException("rule outside allowed scope");
            dynamic rule = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FWRule")!)!;
            rule.Name = name; rule.ApplicationName = Str(r, "program"); rule.Protocol = 6; rule.LocalPorts = port.ToString();
            rule.RemoteAddresses = "LocalSubnet"; rule.InterfaceTypes = "Wireless"; rule.Direction = 1; rule.Action = 1; rule.Enabled = true; rule.Grouping = "CLAN";
            policy.Rules.Add(rule);
        }
        return new JsonObject { ["added"] = rules.Count };
    }

    static JsonNode FirewallRemove()
    {
        dynamic policy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2")!)!;
        var names = new List<string>();
        foreach (dynamic rule in policy.Rules) { string n = rule.Name; if (n.StartsWith("CLAN Direct ")) names.Add(n); }
        foreach (var n in names) policy.Rules.Remove(n);
        return new JsonObject { ["removed"] = names.Count };
    }

    // ---------- member: join the Direct Wi-Fi with the authenticated credential ----------
    static async Task<JsonNode> WifiConnect(string ssid, string pass)
    {
        if (await WiFiAdapter.RequestAccessAsync() != WiFiAccessStatus.Allowed) throw new UnauthorizedAccessException("Windows did not allow CLAN to manage Wi-Fi (Settings › Privacy › Location / Wi-Fi).");
        var adapters = await WiFiAdapter.FindAllAdaptersAsync();
        if (adapters.Count == 0) throw new InvalidOperationException("No Wi-Fi adapter.");
        var a = adapters[0];
        for (var attempt = 0; attempt < 3; attempt++)
        {
            await a.ScanAsync();
            var net = a.NetworkReport.AvailableNetworks.FirstOrDefault(n => n.Ssid == ssid);
            if (net is null) { await Task.Delay(1000); continue; }
            var r = await a.ConnectAsync(net, WiFiReconnectionKind.Manual, new PasswordCredential { Password = pass });
            if (r.ConnectionStatus == WiFiConnectionStatus.Success) return new JsonObject { ["connected"] = true };
            throw new InvalidOperationException($"Could not join {ssid} ({r.ConnectionStatus}).");
        }
        throw new InvalidOperationException($"{ssid} is not in range.");
    }

    // ---------- BLE bootstrap: host (GATT server) ----------
    static async Task<JsonNode?> BleAdvertise(string tag)
    {
        BleStop();
        var created = await GattServiceProvider.CreateAsync(Service);
        if (created.Error != BluetoothError.Success) throw new InvalidOperationException($"Bluetooth GATT service unavailable ({created.Error}).");
        var p = created.ServiceProvider;
        var rx = (await p.Service.CreateCharacteristicAsync(Rx, new GattLocalCharacteristicParameters
        {
            CharacteristicProperties = GattCharacteristicProperties.WriteWithoutResponse | GattCharacteristicProperties.Write,
            WriteProtectionLevel = GattProtectionLevel.Plain, // contents are OPAQUE messages; secrecy comes from OPAQUE + AEAD
        })).Characteristic;
        var tx = (await p.Service.CreateCharacteristicAsync(Tx, new GattLocalCharacteristicParameters
        {
            CharacteristicProperties = GattCharacteristicProperties.Notify, ReadProtectionLevel = GattProtectionLevel.Plain,
        })).Characteristic;
        rx.WriteRequested += async (_, e) =>
        {
            using var d = e.GetDeferral();
            var req = await e.GetRequestAsync();
            if (req is null) return;
            var bytes = req.Value.ToArray();
            if (bytes.Length > 180) return;
            var conn = e.Session.DeviceId.Id;
            if (req.Option == GattWriteOption.WriteWithResponse) req.Respond();
            Emit(new JsonObject { ["ev"] = "ble.request", ["conn"] = conn, ["frame"] = Convert.ToBase64String(bytes) });
        };
        tx.SubscribedClientsChanged += (c, _) => { lock (subscribers) { subscribers.Clear(); foreach (var s in c.SubscribedClients) subscribers[s.Session.DeviceId.Id] = s; } };
        var tagBytes = Convert.FromHexString(tag);
        p.StartAdvertising(new GattServiceProviderAdvertisingParameters { IsConnectable = true, IsDiscoverable = true, ServiceData = tagBytes.AsBuffer() });
        gattProvider = p; txChar = tx;
        return null;
    }

    static JsonNode? BleStop() { gattProvider?.StopAdvertising(); gattProvider = null; txChar = null; lock (subscribers) subscribers.Clear(); return null; }

    static async Task<JsonNode?> BleNotify(string conn, byte[] frame)
    {
        GattSubscribedClient? c;
        lock (subscribers) subscribers.TryGetValue(conn, out c);
        if (c is null || txChar is null) throw new InvalidOperationException("Bluetooth client not subscribed.");
        await txChar.NotifyValueAsync(frame.AsBuffer(), c);
        return null;
    }

    // ---------- BLE bootstrap: member (GATT client) ----------
    static async Task<JsonNode> BleScan(int ms)
    {
        var found = new Dictionary<ulong, JsonObject>();
        var w = new BluetoothLEAdvertisementWatcher { ScanningMode = BluetoothLEScanningMode.Active };
        w.AdvertisementFilter.Advertisement.ServiceUuids.Add(Service);
        w.Received += (_, e) => { lock (found) found[e.BluetoothAddress] = new JsonObject { ["id"] = e.BluetoothAddress.ToString("x12"), ["rssi"] = e.RawSignalStrengthInDBm }; };
        w.Start();
        await Task.Delay(Math.Clamp(ms, 500, 15000));
        w.Stop();
        lock (found) return new JsonObject { ["hosts"] = new JsonArray(found.Values.Select(v => (JsonNode)v.DeepClone()).ToArray()) };
    }

    static async Task<JsonNode> BleConnect(string id)
    {
        var dev = await BluetoothLEDevice.FromBluetoothAddressAsync(Convert.ToUInt64(id, 16)) ?? throw new InvalidOperationException("Host not reachable over Bluetooth.");
        var svc = (await dev.GetGattServicesForUuidAsync(Service, BluetoothCacheMode.Uncached)).Services.FirstOrDefault() ?? throw new InvalidOperationException("Not a CLAN host.");
        var rx = (await svc.GetCharacteristicsForUuidAsync(Rx)).Characteristics.First();
        var tx = (await svc.GetCharacteristicsForUuidAsync(Tx)).Characteristics.First();
        var conn = Guid.NewGuid().ToString();
        tx.ValueChanged += (_, e) => Emit(new JsonObject { ["ev"] = "ble.frame", ["conn"] = conn, ["frame"] = Convert.ToBase64String(e.CharacteristicValue.ToArray()) });
        var s = await tx.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify);
        if (s != GattCommunicationStatus.Success) throw new InvalidOperationException($"Bluetooth subscribe failed ({s}).");
        lock (clients) clients[conn] = (dev, rx, tx);
        return new JsonObject { ["conn"] = conn };
    }

    static async Task<JsonNode?> BleWrite(string conn, byte[] frame)
    {
        (BluetoothLEDevice dev, GattCharacteristic rx, GattCharacteristic tx) c;
        lock (clients) if (!clients.TryGetValue(conn, out c)) throw new InvalidOperationException("Not connected.");
        var s = await c.rx.WriteValueAsync(frame.AsBuffer(), GattWriteOption.WriteWithoutResponse);
        if (s != GattCommunicationStatus.Success) throw new InvalidOperationException($"Bluetooth write failed ({s}).");
        return null;
    }

    static JsonNode? BleClose(string conn)
    {
        lock (clients) if (clients.Remove(conn, out var c)) c.dev.Dispose();
        return null;
    }
}
