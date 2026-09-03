import { Injectable } from '@nestjs/common';

@Injectable()
export class EmailParser {
  sanitizeEmail(email: string) {
    return email.toLowerCase().replace(/[.@]/g, '_');
  }

  extractNetflixResetLink(emailText: string) {
    const cleanText = emailText.replace(/[\u200C-\u200F]/g, '').trim();

    // Mencari link netflix apa saja (password, restart, login, dll)
    const linkMatch = cleanText.match(/https:\/\/www\.netflix\.com\/[^\s>\]]+/);
    const resetLink = linkMatch ? linkMatch[0] : null;

    return resetLink;
  }

  extractNetflixOtp(emailText: string) {
    const cleanText = emailText.replace(/[\u200C-\u200F]/g, '').trim();

    const otpRegex = /^\s*(\d{4,6})\s*$/m;

    const otpMatch = cleanText.match(otpRegex);
    const otpCode = otpMatch ? otpMatch[1] : null;

    return otpCode;
  }

  extractDisneyOtp(emailText: string) {
    const cleanText = emailText.replace(/[\u200C-\u200F]/g, '').trim();
    const otpMatch = cleanText.match(/\b(\d{4,6})\b/);
    const otpCode = otpMatch ? otpMatch[1] : null;
    return otpCode;
  }

  extractByMethod(emailText: string, method: string) {
    const cleanText = emailText.replace(/[\u200C-\u200F]/g, '').trim();

    if (method === 'LINK') {
      const linkMatch = cleanText.match(/https?:\/\/[^\s>\]\"']+/);
      return linkMatch ? linkMatch[0] : null;
    }

    if (method === 'CODE_4') {
      const otpMatch = cleanText.match(/^\s*(\d{4})\s*$/m);
      return otpMatch ? otpMatch[1] : null;
    }

    if (method === 'CODE_6') {
      const otpMatch = cleanText.match(/^\s*(\d{6})\s*$/m);
      return otpMatch ? otpMatch[1] : null;
    }

    if (method === 'CODE_8') {
      const otpMatch = cleanText.match(/^\s*(\d{8})\s*$/m);
      return otpMatch ? otpMatch[1] : null;
    }

    return null;
  }
}
