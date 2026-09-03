import { Injectable } from '@nestjs/common';

@Injectable()
export class EmailParser {
  sanitizeEmail(email: string) {
    return email.replace(/[.@]/g, '_');
  }

  extractNetflixUrl(emailText: string) {
    const cleanText = emailText.replace(/[\u200C-\u200F]/g, '').trim();

    const linkMatch = cleanText.match(/https:\/\/www\.netflix\.com\/(?:password|account\/update-primary-location|account\/travel\/verify|verifyemail|YourAccount)[^\s>\]]*/);
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

    // Ekstrak angka 4 hingga 6 digit pertama yang ada di dalam text
    // Karena plain-body Disney kadang menyatu dengan teks lain
    const otpMatch = cleanText.match(/\b(\d{4,6})\b/);
    const otpCode = otpMatch ? otpMatch[1] : null;

    return otpCode;
  }

  extractByMethod(emailText: string, method: string): string | null {
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
