import {
  validateFields,
  isValidField,
  getValidFields,
  TABLE_FIELDS,
  ValidatableTable,
  type ColumnOf,
  type FieldExpression,
} from "../sqlFieldWhitelist";

/**
 * A field expression the TYPE now forbids, handed to `validateFields` anyway.
 *
 * BACKLOG-2739 gave `validateFields` a column union, so an invented name is a
 * compile error. That does NOT retire the runtime check, and these tests are
 * what prove it: a field name can still arrive from outside the type system —
 * an IPC payload, a `Record<string, unknown>`, a cast — and must be rejected
 * when it does. The cast below says "invalid (or unspellable) on purpose";
 * `@ts-expect-error` would not, because it reads as a defect being tolerated.
 */
function untyped<T extends ValidatableTable>(expr: string): FieldExpression<ColumnOf<T>> {
  return expr as FieldExpression<ColumnOf<T>>;
}

describe("sqlFieldWhitelist", () => {
  /**
   * ==========================================================================
   * THE COMPILE-TIME GATE — BACKLOG-2739 (epic BACKLOG-2738)
   * ==========================================================================
   * Before this change, `TABLE_FIELDS` wrapped every table in `new Set([...])`,
   * which erased the string literals. `npm run type-check` exited 0 on a file
   * containing BOTH lines below — an invented column name was invisible to
   * every gate in the repo.
   *
   * `@ts-expect-error` inverts that: each line now FAILS `npm run
   * type-check:tests` if the error stops occurring. This block is the control,
   * kept executable so nobody has to re-derive it.
   *
   * NOTE: it is a TYPE assertion, not a runtime one. There is nothing to run.
   */
  describe("compile-time gate (type-level control)", () => {
    it("rejects an invented column name at compile time", () => {
      // @ts-expect-error — "totally_made_up_field" is not a transactions column
      const rejected: FieldExpression<ColumnOf<"transactions">> = "totally_made_up_field";
      void rejected;

      // A real column, by contrast, must still be assignable — otherwise the
      // line above would "pass" simply because the type is broken for everyone.
      const accepted: FieldExpression<ColumnOf<"transactions">> = "property_address = ?";
      expect(accepted).toBe("property_address = ?");
    });

    it("no longer exposes Set.has on the definition, which is what hid the hole", () => {
      // Type-checked but NEVER CALLED — `@ts-expect-error` silences the
      // compiler, it does not stop the line running, and `.has` is now a
      // TypeError at runtime. Wrapping it keeps the type assertion while
      // leaving the test's runtime behaviour to the line below.
      const neverInvoked = () =>
        // @ts-expect-error — TABLE_FIELDS.transactions is a readonly array, not a Set
        TABLE_FIELDS.transactions.has("this_column_does_not_exist_anywhere");
      void neverInvoked;

      expect(Array.isArray(TABLE_FIELDS.transactions)).toBe(true);
    });
  });

  describe("TABLE_FIELDS", () => {
    it("should define fields for all expected tables", () => {
      const expectedTables: ValidatableTable[] = [
        "users_local",
        "oauth_tokens",
        "contacts",
        "transactions",
        "communications",
        "transaction_contacts",
      ];

      expectedTables.forEach((table) => {
        expect(TABLE_FIELDS[table]).toBeDefined();
        // BACKLOG-2739: an ARRAY, not a Set. `new Set([...])` erased the string
        // literals and was the whole reason an invented name compiled.
        expect(Array.isArray(TABLE_FIELDS[table])).toBe(true);
        expect(TABLE_FIELDS[table].length).toBeGreaterThan(0);
      });
    });

    it("should include common fields for all tables", () => {
      // All tables should have id and created_at
      const tables: ValidatableTable[] = [
        "users_local",
        "oauth_tokens",
        "contacts",
        "transactions",
        "communications",
        "transaction_contacts",
      ];

      tables.forEach((table) => {
        expect(isValidField(table, "id")).toBe(true);
        expect(isValidField(table, "created_at")).toBe(true);
      });
    });
  });

  describe("validateFields", () => {
    describe("users_local table", () => {
      it("should accept valid user fields", () => {
        expect(() => {
          validateFields("users_local", [
            "email = ?",
            "first_name = ?",
            "last_name = ?",
          ]);
        }).not.toThrow();
      });

      it("should accept valid user fields without = ? suffix", () => {
        expect(() => {
          validateFields("users_local", ["email", "display_name", "avatar_url"]);
        }).not.toThrow();
      });

      it("should reject invalid user fields", () => {
        expect(() => {
          validateFields("users_local", [
            "email = ?",
            untyped<"users_local">("hacker_field = ?"),
          ]);
        }).toThrow('Invalid field "hacker_field" for table "users_local"');
      });

      it("should reject SQL injection attempts", () => {
        expect(() => {
          validateFields("users_local", [
            untyped<"users_local">("email; DROP TABLE users_local;--"),
          ]);
        }).toThrow();
      });
    });

    describe("oauth_tokens table", () => {
      it("should accept valid oauth token fields", () => {
        expect(() => {
          validateFields("oauth_tokens", [
            "access_token = ?",
            "refresh_token = ?",
            "token_expires_at = ?",
          ]);
        }).not.toThrow();
      });

      it("should reject invalid oauth token fields", () => {
        expect(() => {
          validateFields("oauth_tokens", [
            "access_token = ?",
            untyped<"oauth_tokens">("malicious_field = ?"),
          ]);
        }).toThrow('Invalid field "malicious_field" for table "oauth_tokens"');
      });
    });

    describe("contacts table", () => {
      it("should accept valid contact fields", () => {
        expect(() => {
          validateFields("contacts", [
            "display_name = ?",
            "company = ?",
            "title = ?",
          ]);
        }).not.toThrow();
      });

      it("should reject invalid contact fields", () => {
        expect(() => {
          validateFields("contacts", [
            "display_name = ?",
            untyped<"contacts">("password = ?"),
          ]);
        }).toThrow('Invalid field "password" for table "contacts"');
      });
    });

    describe("transactions table", () => {
      it("should accept valid transaction fields", () => {
        expect(() => {
          validateFields("transactions", [
            "property_address = ?",
            "status = ?",
            "closing_deadline = ?",
          ]);
        }).not.toThrow();
      });

      it("should accept AI detection fields", () => {
        expect(() => {
          validateFields("transactions", [
            "detection_source = ?",
            "detection_status = ?",
            "detection_confidence = ?",
            "detection_method = ?",
          ]);
        }).not.toThrow();
      });

      it("should reject invalid transaction fields", () => {
        expect(() => {
          validateFields("transactions", [
            "property_address = ?",
            untyped<"transactions">("admin_override = ?"),
          ]);
        }).toThrow('Invalid field "admin_override" for table "transactions"');
      });
    });

    /**
     * BACKLOG-2739 — THIS BLOCK USED TO ASSERT PHANTOMS.
     *
     * It read `subject = ?` and `body = ?` as valid communication fields. The
     * table has neither, and has not for a long time: `communications` is a
     * JUNCTION (11 columns — ids, link provenance, timestamps). Message content
     * lives in `emails` / `messages`. All 20 "legacy content" names in the old
     * whitelist were phantoms, and this test kept them looking legitimate.
     *
     * The replacements are real columns, taken from `PRAGMA table_info` on a
     * migrated database — see sqlFieldWhitelist.schemaParity.test.ts.
     */
    describe("communications table", () => {
      it("should accept valid communication fields", () => {
        expect(() => {
          validateFields("communications", [
            "transaction_id = ?",
            "link_source = ?",
            "match_reason = ?",
          ]);
        }).not.toThrow();
      });

      it("should reject invalid communication fields", () => {
        expect(() => {
          validateFields("communications", [
            "link_source = ?",
            untyped<"communications">("internal_notes = ?"),
          ]);
        }).toThrow('Invalid field "internal_notes" for table "communications"');
      });

      it("should reject a name this table lost when it became a junction", () => {
        // `subject` was in the whitelist, in the writer, and in this suite —
        // and in no database. It must now be rejected like any other unknown.
        expect(() => {
          validateFields("communications", [untyped<"communications">("subject = ?")]);
        }).toThrow('Invalid field "subject" for table "communications"');
      });
    });

    describe("transaction_contacts table", () => {
      it("should accept valid transaction_contacts fields", () => {
        expect(() => {
          validateFields("transaction_contacts", [
            "role = ?",
            "role_category = ?",
            "specific_role = ?",
            "is_primary = ?",
          ]);
        }).not.toThrow();
      });

      it("should reject invalid transaction_contacts fields", () => {
        expect(() => {
          validateFields("transaction_contacts", [
            "role = ?",
            untyped<"transaction_contacts">("secret_flag = ?"),
          ]);
        }).toThrow('Invalid field "secret_flag" for table "transaction_contacts"');
      });
    });

    describe("edge cases", () => {
      it("should handle empty fields array", () => {
        expect(() => {
          validateFields("contacts", []);
        }).not.toThrow();
      });

      it("should handle fields with extra whitespace", () => {
        // Valid at RUNTIME (the parser splits on `=` and trims) but not
        // spellable as a literal type, so these go through `untyped`.
        expect(() => {
          validateFields("contacts", [
            untyped<"contacts">("  display_name  = ?"),
            untyped<"contacts">("company=?"),
          ]);
        }).not.toThrow();
      });

      it("should reject fields that look like SQL injection", () => {
        const injectionAttempts = [
          "id OR 1=1",
          "id; DELETE FROM contacts",
          "id/**/",
          "id'--",
          "id UNION SELECT",
        ];

        injectionAttempts.forEach((attempt) => {
          expect(() => {
            validateFields("contacts", [untyped<"contacts">(attempt)]);
          }).toThrow();
        });
      });

      it("should reject fields with special characters", () => {
        expect(() => {
          validateFields("contacts", [untyped<"contacts">("display-name = ?")]);
        }).toThrow();
      });
    });
  });

  describe("isValidField", () => {
    it("should return true for valid fields", () => {
      expect(isValidField("contacts", "display_name")).toBe(true);
      expect(isValidField("contacts", "company")).toBe(true);
      expect(isValidField("transactions", "property_address")).toBe(true);
    });

    it("should return false for invalid fields", () => {
      expect(isValidField("contacts", "password")).toBe(false);
      expect(isValidField("contacts", "hacker_field")).toBe(false);
      expect(isValidField("transactions", "admin_override")).toBe(false);
    });
  });

  describe("getValidFields", () => {
    it("should return array of valid fields for each table", () => {
      const contactFields = getValidFields("contacts");
      expect(Array.isArray(contactFields)).toBe(true);
      expect(contactFields).toContain("display_name");
      expect(contactFields).toContain("company");
      expect(contactFields).toContain("title");
    });

    it("should return all fields defined in TABLE_FIELDS", () => {
      const tables: ValidatableTable[] = [
        "users_local",
        "oauth_tokens",
        "contacts",
        "transactions",
        "communications",
        "transaction_contacts",
      ];

      tables.forEach((table) => {
        const fields = getValidFields(table);
        // Exact set, not a count — a count cannot tell "all the fields" apart
        // from "the right number of fields".
        expect([...fields].sort()).toEqual([...TABLE_FIELDS[table]].sort());
      });
    });
  });
});
