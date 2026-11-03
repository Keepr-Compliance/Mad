# Outlook Email Integration Setup Guide

This guide will walk you through setting up the Outlook email integration feature, which allows you to export email communications with your clients to audit folders.

## Overview

The Outlook integration feature:
- Connects to Microsoft 365/Outlook using OAuth authentication
- Pulls all email communication for selected contacts
- Exports emails to audit folders with the client's name and date
- Works with both work and personal Microsoft accounts
- Requires no complex setup for end users - just Microsoft account authentication

## Prerequisites

- Admin access to a Microsoft Azure account (for one-time app registration)
- Microsoft 365 or Outlook.com account (for end users)

## Step 1: Azure App Registration (One-Time Admin Setup)

1. **Go to Azure Portal**
   - Navigate to [https://portal.azure.com](https://portal.azure.com)
   - Sign in with your Microsoft account

2. **Create App Registration**
   - Go to "Azure Active Directory" → "App registrations"
   - Click "+ New registration"
   - Fill in the following:
     - **Name**: `Text Messages to Outlook` (or any name you prefer)
     - **Supported account types**: Select **"Accounts in any organizational directory and personal Microsoft accounts (e.g. Skype, Xbox)"**
       - This allows both work (Microsoft 365) and personal (Outlook.com) accounts
     - **Redirect URI**: Select "Public client/native (mobile & desktop)" and enter `msal://redirect`
   - Click "Register"

3. **Copy Required Values**
   After registration, you'll see the app overview page. Copy these values:
   - **Application (client) ID** - You'll need this
   - **Directory (tenant) ID** - You'll need this (or use "common" for multi-tenant)

4. **Configure API Permissions**
   - In the left menu, click "API permissions"
   - Click "+ Add a permission"
   - Select "Microsoft Graph"
   - Select "Delegated permissions"
   - Add these permissions:
     - `User.Read` - Read user profile
     - `Mail.Read` - Read emails (read-only access)
   - Click "Add permissions"
   - **Optional but recommended**: Click "Grant admin consent" to pre-approve for your organization

5. **Enable Public Client Flow**
   - In the left menu, click "Authentication"
   - Scroll down to "Advanced settings"
   - Under "Allow public client flows", toggle **"Enable the following mobile and desktop flows"** to **Yes**
   - Click "Save"

## Step 2: Configure Your Application

1. **Copy Environment Variables**
   ```bash
   cp .env.local.example .env.local
   ```

2. **Edit `.env.local`**
   Open the `.env.local` file and add your Microsoft credentials:
   ```bash
   # Microsoft Graph API Credentials for Outlook Integration
   MICROSOFT_CLIENT_ID=your-application-client-id-here
   MICROSOFT_TENANT_ID=common
   ```

   - Replace `your-application-client-id-here` with the **Application (client) ID** from Step 1
   - Use `common` for the tenant ID to support all account types (work and personal)
   - If you want to restrict to your organization only, use your specific **Directory (tenant) ID**

3. **Install Dependencies**
   ```bash
   npm install
   ```

## Step 3: End User Experience

End users don't need to do any setup! They just need to:

1. **Launch the Application**
   - Open the Keepr app

2. **Select Contacts**
   - Select the conversations/contacts they want to export

3. **Click "Export to Outlook"**
   - A new button appears next to the regular export button

4. **Authenticate**
   - Click "Sign in with Microsoft"
   - The app uses Microsoft's device code authentication flow
   - A popup will show a code and URL
   - Go to the URL and enter the code
   - Sign in with their Microsoft account
   - Approve the permissions

5. **Export Emails**
   - After authentication, the app will show which contacts have email addresses
   - Click "Export" to download all emails for those contacts
   - Emails are saved to an audit folder with:
     - Client name
     - Date of export
     - Both text format (`.txt`) and JSON format (`.json`)

## Email Export Format

Emails are exported in two formats:

### Text Format (`ContactName_email_audit.txt`)
```
EMAIL AUDIT REPORT
===================

Contact: John Doe
Email: john.doe@example.com
Export Date: 11/13/2025, 10:30:45 AM
Total Emails: 25

================================================================================

EMAIL 1
--------------------------------------------------------------------------------
Date: 11/1/2025, 2:15:30 PM
From: John Doe <john.doe@example.com>
To: Your Name <your.email@example.com>
Subject: Property Inquiry
Importance: normal

Hi, I'm interested in the property at 123 Main St...

================================================================================
```

### JSON Format (`ContactName_email_audit.json`)
Complete email data in JSON format for potential future processing or integration.

## Folder Structure

Exports are saved to:
```
~/Documents/
  └── ContactName_emails_2025-11-13T10-30-45/
      ├── ContactName_email_audit.txt
      └── ContactName_email_audit.json
```

## Security & Privacy

### Authentication
- Uses Microsoft's OAuth 2.0 device code flow
- No passwords are stored in the application
- Access tokens are cached securely on disk (encrypted by OS)
- **Users authenticate once** - tokens automatically refresh for ~90 days
- Users can revoke access at any time through their Microsoft account settings
- Signing out from the app clears all cached tokens

### Permissions
The app requests these Microsoft Graph API permissions:
- `User.Read` - To get the user's email address
- `Mail.Read` - To read emails (read-only access, cannot modify or delete)

### Data Handling
- Emails are only downloaded locally to your computer
- No data is sent to external servers
- All processing happens on the user's machine
- Exported files are saved to the user's local Documents folder

## Troubleshooting

### "Microsoft Client ID not configured" Error
- Make sure you've created the `.env.local` file
- Verify that `MICROSOFT_CLIENT_ID` is set correctly
- Restart the application after making changes

### Authentication Fails
- Check that "Allow public client flows" is enabled in Azure Portal
- Verify that the redirect URI is set to `msal://redirect`
- Make sure the user is entering the correct device code

### No Emails Found
- Verify that the contact has an email address in your contacts
- Check that the email address is correct
- The contact must have sent or received emails through Outlook/Microsoft 365

### "No email address found for contact"
- The contact doesn't have an email address in your Address Book
- Add an email address to the contact in Contacts.app
- Restart the application to reload contacts

## Advanced Configuration

### Restrict to Organization Only
To only allow users from your organization:
```bash
MICROSOFT_TENANT_ID=your-tenant-id-here
```

### Adjust Email Limit
By default, the app fetches up to 100 emails per contact. To change this, modify `outlookService.js`:
```javascript
async getEmailsWithContact(contactEmail, maxResults = 100) {
  // Change 100 to your desired limit
}
```

## Support

If you encounter any issues:
1. Check the application logs
2. Verify your Azure app registration settings
3. Ensure your `.env.local` is configured correctly
4. Make sure npm dependencies are installed

## Notes for Distribution

When distributing the application to end users:
- **DO NOT** distribute your `.env.local` file
- Include the `.env.local.example` file with instructions
- Each user/organization should create their own Azure app registration
- Or, you can distribute with your app registration credentials (users will see your app name during authentication)
