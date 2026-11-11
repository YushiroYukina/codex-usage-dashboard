import Foundation
import Security
// JSON travels over stdin/stdout, never argv. Values are restricted to this app's
// Keychain service and do not read Codex, browser or other application credentials.
let service = "local.usageledger.account-sync.v2"
func finish(_ value: Any?) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["value": value ?? NSNull()])
    FileHandle.standardOutput.write(data); exit(0)
}
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count < 65536, let input = try JSONSerialization.jsonObject(with: data) as? [String:Any], let action = input["action"] as? String, let key = input["key"] as? String, !key.isEmpty, key.utf8.count <= 4096 else { exit(1) }
    let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:service, kSecAttrAccount as String:key]
    if action == "read" {
        var q=query; q[kSecReturnData as String]=true; q[kSecMatchLimit as String]=kSecMatchLimitOne
        var result: CFTypeRef?; let status=SecItemCopyMatching(q as CFDictionary,&result)
        if status == errSecItemNotFound { finish(nil) }
        guard status == errSecSuccess, let stored=result as? Data else { exit(1) }
        finish(try JSONSerialization.jsonObject(with:stored))
    } else if action == "write" {
        guard let value=input["value"] else { exit(1) }; let stored=try JSONSerialization.data(withJSONObject:value)
        let status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:stored] as CFDictionary)
        if status == errSecItemNotFound { var q=query; q[kSecValueData as String]=stored; q[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly; guard SecItemAdd(q as CFDictionary,nil) == errSecSuccess else { exit(1) } }
        else if status != errSecSuccess { exit(1) }; finish(nil)
    } else if action == "delete" {
        let status=SecItemDelete(query as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { exit(1) }; finish(nil)
    } else { exit(1) }
} catch { exit(1) }
